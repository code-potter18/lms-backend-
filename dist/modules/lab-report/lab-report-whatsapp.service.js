"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.labReportWhatsAppService = exports.LabReportWhatsAppService = void 0;
const crypto_1 = require("crypto");
const client_1 = require("@prisma/client");
const prisma_1 = __importDefault(require("../../config/prisma"));
const stateFor = (delivery, patientId) => {
    if (!delivery) {
        return {
            status: "Pending",
            updatedAt: new Date().toISOString(),
            patientId,
        };
    }
    const statuses = {
        PENDING: "Pending",
        PROCESSING: "Sending",
        SENT: "Sent",
        DELIVERED: "Delivered",
        READ: "Read",
        FAILED: "Failed",
    };
    return {
        status: statuses[delivery.status],
        ...(delivery.whatsapp_message_id ? { messageId: delivery.whatsapp_message_id } : {}),
        ...(delivery.error_message ? { error: delivery.error_message } : {}),
        updatedAt: delivery.updated_at.toISOString(),
        ...(delivery.sent_at ? { sentAt: delivery.sent_at.toISOString() } : {}),
        ...(delivery.delivered_at ? { deliveredAt: delivery.delivered_at.toISOString() } : {}),
        ...(delivery.read_at ? { readAt: delivery.read_at.toISOString() } : {}),
        ...(delivery.failed_at ? { failedAt: delivery.failed_at.toISOString() } : {}),
        patientId: delivery.patient_id,
    };
};
const isUniqueConstraintError = (error) => typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002";
const activeDelivery = (reportId, phoneNumber) => prisma_1.default.whatsapp_delivery.findFirst({
    where: {
        lab_report_id: reportId,
        phone_number: phoneNumber,
        status: {
            in: [
                client_1.WhatsappDeliveryStatus.PENDING,
                client_1.WhatsappDeliveryStatus.PROCESSING,
                client_1.WhatsappDeliveryStatus.SENT,
                client_1.WhatsappDeliveryStatus.DELIVERED,
                client_1.WhatsappDeliveryStatus.READ,
            ],
        },
    },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
});
const getReportRecipient = async (reportId) => {
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
                                select: { patient_primary_mobile: true },
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
const normalizedWhatsAppNumber = (mobile) => {
    if (!mobile)
        throw new Error("No registered primary mobile number is available for this patient.");
    let digits = mobile.replace(/\D/g, "");
    if (digits.length === 10)
        digits = `91${digits}`;
    if (!/^[1-9]\d{7,14}$/.test(digits)) {
        throw new Error("The patient's registered mobile number is not a valid international WhatsApp number.");
    }
    return digits;
};
const ensureApprovedReport = (report) => {
    const status = (report.report_status ?? "").trim().toUpperCase();
    if (!["GENERATED", "APPROVED", "FINAL", "FINALIZED", "DELIVERED"].includes(status)) {
        throw new Error("Only an approved/final report can be sent on WhatsApp.");
    }
    if (!report.approved_by || !report.approved_datetime) {
        throw new Error("This report has not been approved by an authorized clinician.");
    }
    const comment = report.report_comment;
    if (comment && typeof comment === "object" && !Array.isArray(comment)) {
        const decision = String(comment.overallDecision ?? "").toUpperCase();
        if (decision && decision !== "APPROVED") {
            throw new Error("This report is not approved for delivery.");
        }
    }
};
const decodePdf = (reportFile) => {
    if (!reportFile)
        throw new Error("The saved PDF for this report is unavailable.");
    const base64 = reportFile.replace(/^data:application\/pdf;base64,/i, "").trim();
    const pdf = Buffer.from(base64, "base64");
    if (pdf.length < 5 || pdf.subarray(0, 5).toString("ascii") !== "%PDF-") {
        throw new Error("The saved report file is not a valid PDF.");
    }
    return pdf;
};
const apiConfiguration = () => ({
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    apiVersion: process.env.WHATSAPP_API_VERSION,
});
class LabReportWhatsAppService {
    async getRecipient(reportId) {
        const report = await getReportRecipient(reportId);
        const patientId = report.lab_order.patient_history?.patient_id;
        if (!patientId)
            throw new Error("The saved report is not linked to a patient.");
        const patient = report.lab_order.patient_history?.patient_bio_data;
        let phoneNumber = null;
        let recipientError = null;
        try {
            phoneNumber = normalizedWhatsAppNumber(patient?.patient_primary_mobile);
        }
        catch (error) {
            recipientError = error instanceof Error ? error.message : "The registered number is invalid.";
        }
        const { accessToken, phoneNumberId, apiVersion } = apiConfiguration();
        const missingConfiguration = [
            !accessToken && "WHATSAPP_ACCESS_TOKEN",
            !phoneNumberId && "WHATSAPP_PHONE_NUMBER_ID",
            !apiVersion && "WHATSAPP_API_VERSION",
        ].filter(Boolean);
        const [consent, delivery] = await Promise.all([
            prisma_1.default.whatsapp_patient_consent.findFirst({
                where: { patient_id: patientId },
                orderBy: [{ created_at: "desc" }, { id: "desc" }],
                select: { consented: true },
            }),
            phoneNumber
                ? prisma_1.default.whatsapp_delivery.findFirst({
                    where: { lab_report_id: report.lab_report_id, phone_number: phoneNumber },
                    orderBy: [{ created_at: "desc" }, { id: "desc" }],
                })
                : Promise.resolve(null),
        ]);
        return {
            patientId,
            phoneNumber: phoneNumber ? `+${phoneNumber}` : null,
            recipientError,
            configured: missingConfiguration.length === 0,
            configurationMessage: missingConfiguration.length > 0
                ? `WhatsApp Business Cloud API is not configured. Set: ${missingConfiguration.join(", ")}.`
                : null,
            consented: consent?.consented ?? false,
            status: stateFor(delivery, patientId),
        };
    }
    async sendReport(reportId, consentConfirmed, actorId) {
        if (consentConfirmed !== true) {
            throw new Error("Confirm that the patient has consented to receive this report on WhatsApp.");
        }
        if (!actorId || actorId.length > 100) {
            throw new Error("The authenticated user cannot be recorded for WhatsApp consent.");
        }
        const report = await getReportRecipient(reportId);
        const patientId = report.lab_order.patient_history?.patient_id;
        if (!patientId)
            throw new Error("The saved report is not linked to a patient.");
        const patient = report.lab_order.patient_history?.patient_bio_data;
        const number = normalizedWhatsAppNumber(patient?.patient_primary_mobile);
        ensureApprovedReport(report);
        const pdf = decodePdf(report.report_file);
        const { accessToken, phoneNumberId, apiVersion } = apiConfiguration();
        if (!accessToken || !phoneNumberId || !apiVersion) {
            throw new Error("WhatsApp Business Cloud API is not configured. Set WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, and WHATSAPP_API_VERSION in the backend environment.");
        }
        await prisma_1.default.whatsapp_patient_consent.create({
            data: {
                patient_id: patientId,
                consented: true,
                consented_by: actorId,
            },
        });
        let delivery;
        try {
            delivery = await prisma_1.default.whatsapp_delivery.create({
                data: {
                    id: (0, crypto_1.randomBytes)(15).toString("hex"),
                    patient_id: patientId,
                    lab_report_id: report.lab_report_id,
                    phone_number: number,
                    status: client_1.WhatsappDeliveryStatus.PENDING,
                    created_by: actorId,
                    updated_at: new Date(),
                },
            });
        }
        catch (error) {
            if (isUniqueConstraintError(error)) {
                const existing = await activeDelivery(report.lab_report_id, number);
                if (existing) {
                    if (existing.status === client_1.WhatsappDeliveryStatus.PROCESSING || existing.status === client_1.WhatsappDeliveryStatus.PENDING) {
                        throw new Error("A WhatsApp send for this report and phone number is already in progress.");
                    }
                    return stateFor(existing, patientId);
                }
            }
            throw error;
        }
        await prisma_1.default.whatsapp_delivery.update({
            where: { id: delivery.id },
            data: { status: client_1.WhatsappDeliveryStatus.PROCESSING, updated_at: new Date() },
        });
        let messageId = "";
        let messageRequestStarted = false;
        let messageResponseAccepted;
        try {
            const baseUrl = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}`;
            const form = new FormData();
            form.append("messaging_product", "whatsapp");
            form.append("type", "application/pdf");
            form.append("file", new Blob([Uint8Array.from(pdf).buffer], { type: "application/pdf" }), `${report.lab_report_id}.pdf`);
            const mediaResponse = await fetch(`${baseUrl}/media`, {
                method: "POST",
                headers: { Authorization: `Bearer ${accessToken}` },
                body: form,
                signal: AbortSignal.timeout(30_000),
            });
            const mediaResult = (await mediaResponse.json());
            if (!mediaResponse.ok || !mediaResult.id) {
                throw new Error(mediaResult.error?.message || "WhatsApp PDF upload failed.");
            }
            await prisma_1.default.whatsapp_delivery.update({
                where: { id: delivery.id },
                data: { media_id: mediaResult.id, updated_at: new Date() },
            });
            messageRequestStarted = true;
            const messageResponse = await fetch(`${baseUrl}/messages`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    messaging_product: "whatsapp",
                    recipient_type: "individual",
                    to: number,
                    type: "document",
                    document: {
                        id: mediaResult.id,
                        filename: `${report.lab_report_id}.pdf`,
                        caption: `Approved laboratory report ${report.lab_report_id}`,
                    },
                }),
                signal: AbortSignal.timeout(30_000),
            });
            messageResponseAccepted = messageResponse.ok;
            const messageResult = (await messageResponse.json());
            messageId = messageResult.messages?.[0]?.id ?? "";
            if (!messageResponse.ok || !messageId) {
                throw new Error(messageResult.error?.message || "WhatsApp did not accept the report message.");
            }
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : "WhatsApp send failed.";
            const failedAt = new Date();
            if (messageRequestStarted && messageResponseAccepted !== false && messageId === "") {
                await prisma_1.default.whatsapp_delivery.update({
                    where: { id: delivery.id },
                    data: {
                        error_message: `Send outcome unknown: ${reason}`.slice(0, 500),
                        updated_at: failedAt,
                    },
                });
                throw new Error("WhatsApp send outcome is unknown; this report is blocked from retrying to prevent a duplicate. Check its delivery status before sending again.");
            }
            await prisma_1.default.whatsapp_delivery.update({
                where: { id: delivery.id },
                data: {
                    status: client_1.WhatsappDeliveryStatus.FAILED,
                    error_message: reason.slice(0, 500),
                    failed_at: failedAt,
                    updated_at: failedAt,
                },
            });
            throw new Error(reason);
        }
        const sentAt = new Date();
        const sentDelivery = await prisma_1.default.whatsapp_delivery.update({
            where: { id: delivery.id },
            data: {
                status: client_1.WhatsappDeliveryStatus.SENT,
                whatsapp_message_id: messageId,
                sent_at: sentAt,
                updated_at: sentAt,
            },
        });
        return stateFor(sentDelivery, patientId);
    }
    async updateWebhookStatuses(payload) {
        if (!payload || typeof payload !== "object")
            return;
        const entry = payload.entry;
        for (const item of entry ?? []) {
            if (!item || typeof item !== "object")
                continue;
            const changes = item.changes;
            for (const change of changes ?? []) {
                if (!change || typeof change !== "object")
                    continue;
                const value = change.value;
                for (const event of value?.statuses ?? []) {
                    if (!event || typeof event !== "object")
                        continue;
                    const statusEvent = event;
                    if (!statusEvent.id)
                        continue;
                    const nextStatus = {
                        sent: client_1.WhatsappDeliveryStatus.SENT,
                        delivered: client_1.WhatsappDeliveryStatus.DELIVERED,
                        read: client_1.WhatsappDeliveryStatus.READ,
                        failed: client_1.WhatsappDeliveryStatus.FAILED,
                    };
                    const status = nextStatus[statusEvent.status ?? ""];
                    if (!status)
                        continue;
                    const delivery = await prisma_1.default.whatsapp_delivery.findUnique({
                        where: { whatsapp_message_id: statusEvent.id },
                    });
                    if (!delivery || delivery.status === client_1.WhatsappDeliveryStatus.READ || delivery.status === client_1.WhatsappDeliveryStatus.FAILED)
                        continue;
                    if (delivery.status === client_1.WhatsappDeliveryStatus.DELIVERED &&
                        status !== client_1.WhatsappDeliveryStatus.READ)
                        continue;
                    const now = new Date();
                    const data = { status, updated_at: now };
                    if (status === client_1.WhatsappDeliveryStatus.SENT)
                        data.sent_at = delivery.sent_at ?? now;
                    if (status === client_1.WhatsappDeliveryStatus.DELIVERED) {
                        data.sent_at = delivery.sent_at ?? now;
                        data.delivered_at = now;
                    }
                    if (status === client_1.WhatsappDeliveryStatus.READ) {
                        data.sent_at = delivery.sent_at ?? now;
                        data.delivered_at = delivery.delivered_at ?? now;
                        data.read_at = now;
                    }
                    if (status === client_1.WhatsappDeliveryStatus.FAILED) {
                        data.failed_at = now;
                        const reason = statusEvent.errors
                            ?.map((item) => item.message || item.title)
                            .filter(Boolean)
                            .join("; ");
                        data.error_message = (reason || "WhatsApp reported that message delivery failed.").slice(0, 500);
                    }
                    await prisma_1.default.whatsapp_delivery.update({ where: { id: delivery.id }, data });
                }
            }
        }
    }
    verifyWebhookSignature(rawBody, signature) {
        const appSecret = process.env.WHATSAPP_APP_SECRET;
        if (!appSecret || !signature?.startsWith("sha256="))
            return false;
        const expected = Buffer.from(`sha256=${(0, crypto_1.createHmac)("sha256", appSecret).update(rawBody).digest("hex")}`);
        const actual = Buffer.from(signature);
        return expected.length === actual.length && (0, crypto_1.timingSafeEqual)(expected, actual);
    }
}
exports.LabReportWhatsAppService = LabReportWhatsAppService;
exports.labReportWhatsAppService = new LabReportWhatsAppService();
