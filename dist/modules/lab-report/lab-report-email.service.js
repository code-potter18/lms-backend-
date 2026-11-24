"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.labReportEmailService = exports.LabReportEmailService = void 0;
const crypto_1 = require("crypto");
const client_1 = require("@prisma/client");
const prisma_1 = __importDefault(require("../../config/prisma"));
const mail_1 = require("../../utils/mail");
const patient_portal_service_1 = require("../patient-portal/patient-portal.service");
/* A PROCESSING row older than this cannot still be sending - the process that
   owned it is gone. It is moved to FAILED so the delivery can be retried
   instead of blocking the report forever. */
const STALE_ATTEMPT_MS = 15 * 60 * 1000;
const isEmailMigrationMissing = (error) => error?.code === "P2021" || error?.code === "42P01";
const getReport = async (reportId) => {
    const report = await prisma_1.default.lab_report.findUnique({
        where: { lab_report_id: reportId },
        select: {
            lab_report_id: true,
            report_status: true,
            report_file: true,
            approved_by: true,
            approved_datetime: true,
            report_comment: true,
            lab_order: {
                select: {
                    patient_history: {
                        select: {
                            patient_id: true,
                            patient_bio_data: {
                                select: {
                                    patient_email: true,
                                    patient_first_name: true,
                                    patient_middle_name: true,
                                    patient_last_name: true,
                                },
                            },
                        },
                    },
                },
            },
        },
    });
    if (!report)
        throw new Error("Saved lab report not found.");
    return report;
};
const emailAddressFor = (report) => {
    const patient = report.lab_order.patient_history;
    if (!patient?.patient_id)
        throw new Error("The saved report is not linked to a patient.");
    const email = patient.patient_bio_data?.patient_email?.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new Error("This patient has no valid registered email. An authorized user must add one before delivery.");
    }
    return { patientId: patient.patient_id, email };
};
const patientNameFor = (report) => {
    const patient = report.lab_order.patient_history?.patient_bio_data;
    if (!patient)
        return "Patient";
    const name = [patient.patient_first_name, patient.patient_middle_name, patient.patient_last_name]
        .map((part) => (typeof part === "string" ? part.trim() : ""))
        .filter(Boolean)
        .join(" ");
    return name || "Patient";
};
const ensureApprovedReport = (report) => {
    const status = (report.report_status ?? "").trim().toUpperCase();
    if (!["GENERATED", "APPROVED", "FINAL", "FINALIZED", "DELIVERED"].includes(status)) {
        throw new Error("Only an approved/final report can be sent by email.");
    }
    if (!report.approved_by || !report.approved_datetime) {
        throw new Error("This report has not been approved by an authorized clinician.");
    }
    if (report.report_comment && typeof report.report_comment === "object" && !Array.isArray(report.report_comment)) {
        const decision = String(report.report_comment.overallDecision ?? "").toUpperCase();
        if (decision && decision !== "APPROVED") {
            throw new Error("This report is not approved for delivery.");
        }
    }
};
const decodePdf = (reportFile) => {
    if (!reportFile)
        throw new Error("The saved PDF for this report is unavailable.");
    const pdf = Buffer.from(reportFile.replace(/^data:application\/pdf(;[^;]*)?;base64,/i, "").trim(), "base64");
    if (pdf.length < 5 || pdf.subarray(0, 5).toString("ascii") !== "%PDF-") {
        throw new Error("The saved report file is not a valid PDF.");
    }
    return pdf;
};
/* Marks an abandoned PROCESSING attempt as FAILED so retry becomes possible.
   Never touches a live attempt (younger than STALE_ATTEMPT_MS). */
const recoverStaleAttempt = async (reportId) => {
    const latest = await prisma_1.default.lab_report_email_delivery.findFirst({
        where: { lab_report_id: reportId },
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
    });
    if (latest?.status !== client_1.EmailDeliveryStatus.PROCESSING)
        return;
    if (Date.now() - latest.updated_at.getTime() < STALE_ATTEMPT_MS)
        return;
    const now = new Date();
    await prisma_1.default.lab_report_email_delivery.update({
        where: { id: latest.id },
        data: {
            status: client_1.EmailDeliveryStatus.FAILED,
            error_message: "The previous send attempt did not complete and was marked failed.",
            failed_at: now,
            updated_at: now,
        },
    });
};
const statusResponse = (delivery, patientId) => ({
    patientId,
    emailAddress: delivery?.email_address ?? null,
    configured: Boolean(process.env.MAIL_HOST && process.env.MAIL_USER && process.env.MAIL_PASS),
    configurationMessage: process.env.MAIL_HOST && process.env.MAIL_USER && process.env.MAIL_PASS
        ? null
        : "Email delivery is not configured. Set MAIL_HOST, MAIL_PORT, MAIL_USER, MAIL_PASS, and optionally MAIL_FROM in the backend environment.",
    consented: Boolean(delivery),
    status: delivery
        ? {
            status: delivery.status,
            deliveryId: delivery.id,
            messageId: delivery.message_id ?? undefined,
            error: delivery.error_message ?? undefined,
            updatedAt: delivery.updated_at.toISOString(),
            sentAt: delivery.sent_at?.toISOString(),
            failedAt: delivery.failed_at?.toISOString(),
        }
        : { status: "PENDING", updatedAt: new Date().toISOString() },
});
class LabReportEmailService {
    async getRecipient(reportId) {
        const report = await getReport(reportId);
        const patientId = report.lab_order.patient_history?.patient_id;
        if (!patientId)
            throw new Error("The saved report is not linked to a patient.");
        const email = report.lab_order.patient_history?.patient_bio_data?.patient_email?.trim() || null;
        let consent = null;
        let delivery = null;
        try {
            await recoverStaleAttempt(reportId);
            [consent, delivery] = await Promise.all([
                email ? prisma_1.default.patient_email_consent.findFirst({
                    where: { patient_id: patientId, email_address: { equals: email, mode: "insensitive" } },
                    orderBy: [{ created_at: "desc" }, { id: "desc" }],
                    select: { consented: true },
                }) : Promise.resolve(null),
                prisma_1.default.lab_report_email_delivery.findFirst({
                    where: { lab_report_id: report.lab_report_id },
                    orderBy: [{ created_at: "desc" }, { id: "desc" }],
                }),
            ]);
        }
        catch (error) {
            if (!isEmailMigrationMissing(error))
                throw error;
            return {
                ...statusResponse(null, patientId),
                emailAddress: email,
                configured: false,
                configurationMessage: "Email delivery history and consent storage are unavailable until the approved email migration is applied.",
                consented: false,
                recipientError: email ? null : "No registered email is available. An authorized user must add one before delivery.",
            };
        }
        return {
            ...statusResponse(delivery, patientId),
            emailAddress: email,
            consented: consent?.consented ?? false,
            recipientError: email ? null : "No registered email is available. An authorized user must add one before delivery.",
        };
    }
    /* Manual send/retry from the Report Transfer screen. The operator confirms
       the patient consented, so that attestation is recorded. */
    async sendReport(reportId, consentConfirmed, actorId) {
        if (!consentConfirmed) {
            throw new Error("Confirm that the patient has consented to receive this report by email.");
        }
        if (!actorId || actorId.length > 100) {
            throw new Error("The authenticated user cannot be recorded for email consent.");
        }
        const report = await getReport(reportId);
        ensureApprovedReport(report);
        const { patientId, email } = emailAddressFor(report);
        const pdf = decodePdf(report.report_file);
        return this.deliver(report, patientId, email, pdf, actorId, true);
    }
    async deliver(report, patientId, email, pdf, actorId, recordConsent) {
        await recoverStaleAttempt(report.lab_report_id);
        let delivery;
        try {
            delivery = await prisma_1.default.$transaction(async (transaction) => {
                const created = await transaction.lab_report_email_delivery.create({
                    data: {
                        id: (0, crypto_1.randomUUID)(),
                        patient_id: patientId,
                        lab_report_id: report.lab_report_id,
                        email_address: email,
                        status: client_1.EmailDeliveryStatus.PENDING,
                        created_by: actorId,
                        updated_at: new Date(),
                    },
                });
                if (recordConsent) {
                    await transaction.patient_email_consent.create({
                        data: {
                            patient_id: patientId,
                            email_address: email,
                            consented: true,
                            consented_by: actorId,
                        },
                    });
                }
                return transaction.lab_report_email_delivery.update({
                    where: { id: created.id },
                    data: { status: client_1.EmailDeliveryStatus.PROCESSING, updated_at: new Date() },
                });
            });
        }
        catch (error) {
            if (typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code === "P2002") {
                const existing = await prisma_1.default.lab_report_email_delivery.findFirst({
                    where: {
                        lab_report_id: report.lab_report_id,
                        status: {
                            in: [
                                client_1.EmailDeliveryStatus.PENDING,
                                client_1.EmailDeliveryStatus.PROCESSING,
                                client_1.EmailDeliveryStatus.SENT,
                                client_1.EmailDeliveryStatus.UNKNOWN,
                            ],
                        },
                    },
                    orderBy: [{ created_at: "desc" }, { id: "desc" }],
                });
                if (existing) {
                    throw new Error(existing.status === client_1.EmailDeliveryStatus.SENT
                        ? "This report has already been sent to the registered email."
                        : existing.status === client_1.EmailDeliveryStatus.UNKNOWN
                            ? "The previous email outcome is unknown; retry is blocked to prevent duplicate delivery."
                            : "An email send for this report is already in progress.");
                }
            }
            throw error;
        }
        const tracker = { messageDataStarted: false };
        try {
            const result = await (0, mail_1.sendLabReportEmail)(email, report.lab_report_id, pdf, patientNameFor(report), tracker);
            if (!(result.accepted ?? []).some((recipient) => recipient.toLowerCase() === email.toLowerCase())) {
                const reason = "The SMTP server did not accept the patient's email address.";
                const failedAt = new Date();
                await prisma_1.default.lab_report_email_delivery.update({
                    where: { id: delivery.id },
                    data: {
                        status: client_1.EmailDeliveryStatus.FAILED,
                        error_message: reason,
                        failed_at: failedAt,
                        updated_at: failedAt,
                    },
                });
                // Trigger in-app notification: Report Email Delivery Failed
                const eventKey = `REPORT_EMAIL_FAILED:${delivery.id}`;
                patient_portal_service_1.PatientPortalService.createNotification(patientId, "Report Email Delivery Failed", "We could not send your laboratory report by email. Please contact the laboratory for assistance.", "REPORT_EMAIL_FAILED", `EMAIL_FAIL_${delivery.id}`, eventKey).catch(() => { });
                throw new Error(reason);
            }
            const sentAt = new Date();
            const sent = await prisma_1.default.lab_report_email_delivery.update({
                where: { id: delivery.id },
                data: {
                    status: client_1.EmailDeliveryStatus.SENT,
                    message_id: result.messageId || null,
                    sent_at: sentAt,
                    updated_at: sentAt,
                },
            });
            // Trigger in-app notification: Report Email Successfully Sent
            const eventKey = `REPORT_EMAIL_SENT:${delivery.id}`;
            patient_portal_service_1.PatientPortalService.createNotification(patientId, "Report Email Sent", "Your laboratory report has been successfully sent to your registered email address.", "REPORT_EMAIL_SENT", `EMAIL_SENT_${delivery.id}`, eventKey).catch(() => { });
            return statusResponse(sent, patientId);
        }
        catch (error) {
            const current = await prisma_1.default.lab_report_email_delivery.findUnique({
                where: { id: delivery.id },
            });
            if (current?.status === client_1.EmailDeliveryStatus.FAILED)
                throw error;
            const reason = error instanceof Error ? error.message : "Email delivery failed.";
            const smtpResponseCode = typeof error === "object" && error !== null && "responseCode" in error
                ? Number(error.responseCode)
                : null;
            /* A server rejection (responseCode) or a failure before the server
               answered 354 to DATA is a clean FAILED: nothing reached the patient, so
               a retry is safe. Once the message body was being transmitted a broken
               connection leaves the outcome genuinely unknown - resending could
               duplicate the email. `command === "DATA"` covers nodemailer builds
               that report the phase directly. */
            const command = typeof error === "object" && error !== null && "command" in error
                ? String(error.command ?? "").toUpperCase()
                : "";
            const outcomeUnknown = !smtpResponseCode && (command === "DATA" || tracker.messageDataStarted);
            const failedAt = new Date();
            await prisma_1.default.lab_report_email_delivery.update({
                where: { id: delivery.id },
                data: {
                    status: outcomeUnknown ? client_1.EmailDeliveryStatus.UNKNOWN : client_1.EmailDeliveryStatus.FAILED,
                    error_message: `${outcomeUnknown ? "Send outcome unknown: " : ""}${reason}`.slice(0, 500),
                    ...(outcomeUnknown ? {} : { failed_at: failedAt }),
                    updated_at: failedAt,
                },
            });
            // Trigger in-app notification for genuine failure
            if (!outcomeUnknown) {
                const eventKey = `REPORT_EMAIL_FAILED:${delivery.id}`;
                patient_portal_service_1.PatientPortalService.createNotification(patientId, "Report Email Delivery Failed", "We could not send your laboratory report by email. Please contact the laboratory for assistance.", "REPORT_EMAIL_FAILED", `EMAIL_FAIL_${delivery.id}`, eventKey).catch(() => { });
            }
            if (outcomeUnknown) {
                throw new Error("Email send outcome is unknown; retry is blocked to prevent duplicate delivery. Check the delivery status before taking further action.");
            }
            throw error;
        }
    }
}
exports.LabReportEmailService = LabReportEmailService;
exports.labReportEmailService = new LabReportEmailService();
