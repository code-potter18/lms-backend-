import * as nodemailer from "nodemailer";

let transporter: nodemailer.Transporter | null = null;

const isSmtpConfigured = () =>
  Boolean(process.env.MAIL_HOST && process.env.MAIL_USER && process.env.MAIL_PASS);

const getTransporter = () => {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.MAIL_HOST,
      port: Number(process.env.MAIL_PORT) || 587,
      secure: Number(process.env.MAIL_PORT) === 465,
      auth: {
        user: process.env.MAIL_USER,
        pass: process.env.MAIL_PASS,
      },
    });
  
  transporter.verify((error, success) => {
    if (error) {         
    console.error("SMTP Verify Error:", error);
   } else 
    {console.log("SMTP Server is ready");

     }
     });}

  return transporter;
};

export const sendOtpEmail = async (
  to: string,
  otp: string
) => {
  if (!isSmtpConfigured()) {
    console.warn(
      `[dev] SMTP not configured (set MAIL_HOST/MAIL_USER/MAIL_PASS) - OTP for ${to}: ${otp}`
    );
    return;
  }

  await getTransporter().sendMail({
    from: process.env.MAIL_FROM || process.env.MAIL_USER,
    to,
    subject: "Your Login OTP",
    html: `
      <h2>Hospital Management System</h2>
      <p>Your OTP is:</p>
      <h1>${otp}</h1>
      <p>This OTP is valid for 5 minutes.</p>
    `,
  });
};

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });

export type LabReportSendTracker = {
  /* Set as soon as the SMTP server answers 354 to DATA, i.e. the point from
     which the message body may already have reached the recipient. */
  messageDataStarted: boolean;
};

/* A dedicated transport is used for lab reports so the SMTP dialogue can be
   inspected: a connection lost after 354 has an undetermined outcome, while
   a failure before it is safely retryable. The custom logger swallows the
   protocol output instead of printing it. */
const createTrackedTransporter = (tracker: LabReportSendTracker) =>
  nodemailer.createTransport({
    host: process.env.MAIL_HOST,
    port: Number(process.env.MAIL_PORT) || 587,
    secure: Number(process.env.MAIL_PORT) === 465,
    auth: {
      user: process.env.MAIL_USER,
      pass: process.env.MAIL_PASS,
    },
    debug: true,
    logger: {
      debug: (...args: unknown[]) => {
        const [entry, message] = args;
        if (
          entry &&
          typeof entry === "object" &&
          (entry as { tnx?: string }).tnx === "server" &&
          typeof message === "string" &&
          /^354\b/.test(message)
        ) {
          tracker.messageDataStarted = true;
        }
      },
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  });

export const sendLabReportEmail = async (
  to: string,
  reportId: string,
  pdf: Buffer,
  patientName?: string,
  tracker?: LabReportSendTracker,
) => {
  if (!isSmtpConfigured()) {
    throw new Error(
      "Lab report email is not configured. Set MAIL_HOST, MAIL_USER, and MAIL_PASS in the backend environment.",
    );
  }

  const name = patientName?.trim() || "Patient";
  const greeting = name === "Patient" ? "Dear Patient," : `Dear ${name},`;
  const body =
    "Your laboratory test report is ready.\n\n" +
    "Please find your laboratory report attached to this email.\n\n" +
    "For any clarification regarding your report, please contact the hospital laboratory department.\n\n" +
    "Thank you for choosing our services.\n\n" +
    "Regards,\nHMS Laboratory Department";

  return (tracker ? createTrackedTransporter(tracker) : getTransporter()).sendMail({
    from: process.env.MAIL_FROM || process.env.MAIL_USER,
    to,
    subject: "Your Laboratory Test Report - HMS",
    text: `${greeting}\n\n${body}`,
    html: `
      <div style="font-family: Arial, Helvetica, sans-serif; color: #1f2937; line-height: 1.6;">
        <p>${escapeHtml(greeting)}</p>
        <p>Your laboratory test report is ready.</p>
        <p>Please find your laboratory report attached to this email.</p>
        <p>For any clarification regarding your report, please contact the hospital laboratory department.</p>
        <p>Thank you for choosing our services.</p>
        <p style="margin-bottom: 0;">Regards,<br />HMS Laboratory Department</p>
      </div>
    `,
    attachments: [
      {
        filename: `Lab_Report_${reportId}.pdf`,
        content: pdf,
        contentType: "application/pdf",
      },
    ],
  });
};

export const sendPatientActivationEmail = async (
  to: string,
  patientName: string,
  token: string
) => {
  if (!isSmtpConfigured()) {
    console.warn(
      `[dev] SMTP not configured - Patient activation token for ${to}: ${token}`
    );
    return;
  }

  const name = patientName?.trim() || "Patient";
  return getTransporter().sendMail({
    from: process.env.MAIL_FROM || process.env.MAIL_USER,
    to,
    subject: "Set Your Patient Portal Password - Laboratory Services",
    html: `
      <div style="font-family: Arial, Helvetica, sans-serif; color: #1f2937; line-height: 1.6; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #00488D;">Welcome to Laboratory Patient Portal</h2>
        <p>Dear ${escapeHtml(name)},</p>
        <p>Your patient account has been created. Use the verification token below to set your password and access your test results and reports:</p>
        <div style="background-color: #F0F4F8; padding: 15px; border-radius: 8px; text-align: center; margin: 20px 0;">
          <span style="font-size: 28px; font-weight: bold; letter-spacing: 4px; color: #00488D;">${escapeHtml(token)}</span>
        </div>
        <p>This token is valid for 24 hours. For security, never share this token with anyone.</p>
        <p>Regards,<br />Laboratory Department</p>
      </div>
    `,
  });
};

export const sendPatientReportAvailableEmail = async (
  to: string,
  patientName: string,
  reportId: string,
  testNames?: string[]
) => {
  if (!isSmtpConfigured()) {
    console.warn(
      `[dev] SMTP not configured - Report available notification for ${to} (Report: ${reportId})`
    );
    return;
  }

  const name = patientName?.trim() || "Patient";
  const testsStr = testNames?.length ? ` (${testNames.join(", ")})` : "";
  return getTransporter().sendMail({
    from: process.env.MAIL_FROM || process.env.MAIL_USER,
    to,
    subject: `Your Lab Report is Ready${testsStr}`,
    html: `
      <div style="font-family: Arial, Helvetica, sans-serif; color: #1f2937; line-height: 1.6; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #00488D;">Laboratory Test Report Ready</h2>
        <p>Dear ${escapeHtml(name)},</p>
        <p>Your laboratory test report <strong>#${escapeHtml(reportId)}</strong>${escapeHtml(testsStr)} has been approved and is now available in your Patient Portal.</p>
        <p>Please log in to your Patient Portal to view and securely download your report.</p>
        <p>Regards,<br />Laboratory Department</p>
      </div>
    `,
  });
};
