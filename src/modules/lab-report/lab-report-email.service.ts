import { randomUUID } from "crypto";
import { EmailDeliveryStatus } from "@prisma/client";
import prisma from "../../config/prisma";
import { sendLabReportEmail } from "../../utils/mail";

type ReportWithPatient = {
  lab_report_id: string;
  report_status: string | null;
  report_file: string | null;
  approved_by: string | null;
  approved_datetime: Date | null;
  report_comment: unknown;
  lab_order: {
    patient_history: {
      patient_id: string;
      patient_bio_data: { patient_email: string | null } | null;
    } | null;
  };
};

const getReport = async (reportId: string): Promise<ReportWithPatient> => {
  const report = await prisma.lab_report.findUnique({
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
              patient_bio_data: { select: { patient_email: true } },
            },
          },
        },
      },
    },
  });
  if (!report) throw new Error("Saved lab report not found.");
  return report;
};

const emailAddressFor = (report: ReportWithPatient) => {
  const patient = report.lab_order.patient_history;
  if (!patient?.patient_id) throw new Error("The saved report is not linked to a patient.");
  const email = patient.patient_bio_data?.patient_email?.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("This patient has no valid registered email. An authorized user must add one before delivery.");
  }
  return { patientId: patient.patient_id, email };
};

const ensureApprovedReport = (report: ReportWithPatient) => {
  const status = (report.report_status ?? "").trim().toUpperCase();
  if (!["GENERATED", "APPROVED", "FINAL", "FINALIZED", "DELIVERED"].includes(status)) {
    throw new Error("Only an approved/final report can be sent by email.");
  }
  if (!report.approved_by || !report.approved_datetime) {
    throw new Error("This report has not been approved by an authorized clinician.");
  }
  if (report.report_comment && typeof report.report_comment === "object" && !Array.isArray(report.report_comment)) {
    const decision = String(
      (report.report_comment as Record<string, unknown>).overallDecision ?? "",
    ).toUpperCase();
    if (decision && decision !== "APPROVED") {
      throw new Error("This report is not approved for delivery.");
    }
  }
};

const decodePdf = (reportFile: string | null): Buffer => {
  if (!reportFile) throw new Error("The saved PDF for this report is unavailable.");
  const pdf = Buffer.from(
    reportFile.replace(/^data:application\/pdf;base64,/i, "").trim(),
    "base64",
  );
  if (pdf.length < 5 || pdf.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("The saved report file is not a valid PDF.");
  }
  return pdf;
};

const statusResponse = (
  delivery: {
    id: string;
    status: EmailDeliveryStatus;
    email_address: string;
    message_id: string | null;
    error_message: string | null;
    created_at: Date;
    updated_at: Date;
    sent_at: Date | null;
    failed_at: Date | null;
  } | null,
  patientId: string,
) => ({
  patientId,
  emailAddress: delivery?.email_address ?? null,
  configured: Boolean(process.env.MAIL_HOST && process.env.MAIL_USER && process.env.MAIL_PASS),
  configurationMessage:
    process.env.MAIL_HOST && process.env.MAIL_USER && process.env.MAIL_PASS
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
    : { status: "PENDING" as const, updatedAt: new Date().toISOString() },
});

export class LabReportEmailService {
  async getRecipient(reportId: string) {
    const report = await getReport(reportId);
    const patientId = report.lab_order.patient_history?.patient_id;
    if (!patientId) throw new Error("The saved report is not linked to a patient.");
    const email = report.lab_order.patient_history?.patient_bio_data?.patient_email?.trim() || null;
    const [consent, delivery] = await Promise.all([
      email ? prisma.patient_email_consent.findFirst({
        where: { patient_id: patientId, email_address: { equals: email, mode: "insensitive" } },
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
        select: { consented: true },
      }) : Promise.resolve(null),
      prisma.lab_report_email_delivery.findFirst({
        where: { lab_report_id: report.lab_report_id },
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
      }),
    ]);
    return {
      ...statusResponse(delivery, patientId),
      emailAddress: email,
      consented: consent?.consented ?? false,
      recipientError: email ? null : "No registered email is available. An authorized user must add one before delivery.",
    };
  }

  async sendReport(reportId: string, consentConfirmed: boolean, actorId: string) {
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

    let delivery;
    try {
      delivery = await prisma.$transaction(async (transaction) => {
        const created = await transaction.lab_report_email_delivery.create({
          data: {
            id: randomUUID(),
            patient_id: patientId,
            lab_report_id: report.lab_report_id,
            email_address: email,
            status: EmailDeliveryStatus.PENDING,
            created_by: actorId,
            updated_at: new Date(),
          },
        });
        await transaction.patient_email_consent.create({
          data: {
            patient_id: patientId,
            email_address: email,
            consented: true,
            consented_by: actorId,
          },
        });
        return transaction.lab_report_email_delivery.update({
          where: { id: created.id },
          data: { status: EmailDeliveryStatus.PROCESSING, updated_at: new Date() },
        });
      });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "P2002"
      ) {
        const existing = await prisma.lab_report_email_delivery.findFirst({
          where: {
            lab_report_id: report.lab_report_id,
            status: { in: [EmailDeliveryStatus.PENDING, EmailDeliveryStatus.PROCESSING, EmailDeliveryStatus.SENT, EmailDeliveryStatus.UNKNOWN] },
          },
          orderBy: [{ created_at: "desc" }, { id: "desc" }],
        });
        if (existing) {
          if (existing.status === EmailDeliveryStatus.FAILED) {
            throw new Error("Delivery failed; use retry to create a new send attempt.");
          }
          throw new Error(
            existing.status === EmailDeliveryStatus.SENT
              ? "This report has already been sent to the registered email."
              : existing.status === EmailDeliveryStatus.UNKNOWN
                ? "The previous email outcome is unknown; retry is blocked to prevent duplicate delivery."
                : "An email send for this report is already in progress.",
          );
        }
      }
      throw error;
    }

    try {
      const result = await sendLabReportEmail(email, report.lab_report_id, pdf);
      if (!(result.accepted ?? []).some((recipient) => recipient.toLowerCase() === email.toLowerCase())) {
        const reason = "The SMTP server did not accept the patient's email address.";
        const failedAt = new Date();
        await prisma.lab_report_email_delivery.update({
          where: { id: delivery.id },
          data: {
            status: EmailDeliveryStatus.FAILED,
            error_message: reason,
            failed_at: failedAt,
            updated_at: failedAt,
          },
        });
        throw new Error(reason);
      }
      const sentAt = new Date();
      const sent = await prisma.lab_report_email_delivery.update({
        where: { id: delivery.id },
        data: {
          status: EmailDeliveryStatus.SENT,
          message_id: result.messageId || null,
          sent_at: sentAt,
          updated_at: sentAt,
        },
      });
      return statusResponse(sent, patientId);
    } catch (error) {
      const current = await prisma.lab_report_email_delivery.findUnique({
        where: { id: delivery.id },
      });
      if (current?.status === EmailDeliveryStatus.FAILED) throw error;

      const reason = error instanceof Error ? error.message : "Email delivery failed.";
      const smtpResponseCode =
        typeof error === "object" && error !== null && "responseCode" in error
          ? Number(error.responseCode)
          : null;
      const outcomeUnknown = !smtpResponseCode;
      const failedAt = new Date();
      await prisma.lab_report_email_delivery.update({
        where: { id: delivery.id },
        data: {
          status: outcomeUnknown ? EmailDeliveryStatus.UNKNOWN : EmailDeliveryStatus.FAILED,
          error_message: `${outcomeUnknown ? "Send outcome unknown: " : ""}${reason}`.slice(0, 500),
          ...(outcomeUnknown ? {} : { failed_at: failedAt }),
          updated_at: failedAt,
        },
      });
      if (outcomeUnknown) {
        throw new Error(
          "Email send outcome is unknown; retry is blocked to prevent duplicate delivery. Check the delivery status before taking further action.",
        );
      }
      throw error;
    }
  }
}

export const labReportEmailService = new LabReportEmailService();
