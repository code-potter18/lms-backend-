"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendPatientReportAvailableEmail = exports.sendPatientActivationEmail = exports.sendLabReportEmail = exports.sendOtpEmail = void 0;
const nodemailer = __importStar(require("nodemailer"));
let transporter = null;
const isSmtpConfigured = () => Boolean(process.env.MAIL_HOST && process.env.MAIL_USER && process.env.MAIL_PASS);
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
            }
            else {
                console.log("SMTP Server is ready");
            }
        });
    }
    return transporter;
};
const sendOtpEmail = async (to, otp) => {
    if (!isSmtpConfigured()) {
        console.warn(`[dev] SMTP not configured (set MAIL_HOST/MAIL_USER/MAIL_PASS) - OTP for ${to}: ${otp}`);
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
exports.sendOtpEmail = sendOtpEmail;
const escapeHtml = (value) => value.replace(/[&<>"']/g, (character) => {
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
/* A dedicated transport is used for lab reports so the SMTP dialogue can be
   inspected: a connection lost after 354 has an undetermined outcome, while
   a failure before it is safely retryable. The custom logger swallows the
   protocol output instead of printing it. */
const createTrackedTransporter = (tracker) => nodemailer.createTransport({
    host: process.env.MAIL_HOST,
    port: Number(process.env.MAIL_PORT) || 587,
    secure: Number(process.env.MAIL_PORT) === 465,
    auth: {
        user: process.env.MAIL_USER,
        pass: process.env.MAIL_PASS,
    },
    debug: true,
    logger: {
        debug: (...args) => {
            const [entry, message] = args;
            if (entry &&
                typeof entry === "object" &&
                entry.tnx === "server" &&
                typeof message === "string" &&
                /^354\b/.test(message)) {
                tracker.messageDataStarted = true;
            }
        },
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
    },
});
const sendLabReportEmail = async (to, reportId, pdf, patientName, tracker) => {
    if (!isSmtpConfigured()) {
        throw new Error("Lab report email is not configured. Set MAIL_HOST, MAIL_USER, and MAIL_PASS in the backend environment.");
    }
    const name = patientName?.trim() || "Patient";
    const greeting = name === "Patient" ? "Dear Patient," : `Dear ${name},`;
    const body = "Your laboratory test report is ready.\n\n" +
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
exports.sendLabReportEmail = sendLabReportEmail;
const sendPatientActivationEmail = async (to, patientName, token, patientId, username, isReset = false) => {
    const portalUrl = process.env.PATIENT_PORTAL_URL ||
        process.env.CLIENT_URL ||
        "http://localhost:5173";
    const activationUrl = `${portalUrl}/set-password?id=${encodeURIComponent(username || patientId || "")}${isReset ? "&mode=reset" : "&mode=activate"}`;
    const subject = isReset
        ? "Reset Your Patient Portal Password - Laboratory Services"
        : "Activate Your Patient Portal Account - Laboratory Services";
    const actionText = isReset
        ? "reset your password"
        : "set your password and activate your account";
    const buttonLabel = isReset ? "Reset Password" : "Activate Account";
    if (!isSmtpConfigured()) {
        console.warn(`[SMTP Notification] ${subject} prepared for ${to}. Email delivery skipped.`);
        return;
    }
    const name = patientName?.trim() || "Patient";
    const identifierDisplay = username || patientId;
    return getTransporter().sendMail({
        from: process.env.MAIL_FROM || process.env.MAIL_USER,
        to,
        subject,
        html: `
      <div style="font-family: Arial, Helvetica, sans-serif; color: #1f2937; line-height: 1.6; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #00488D;">Welcome to Laboratory Patient Portal</h2>
        <p>Dear ${escapeHtml(name)},</p>
        <p>Your patient portal account has been prepared${identifierDisplay ? ` with Username: <strong>${escapeHtml(identifierDisplay)}</strong>` : ""}.</p>
        <p>Please click the button below to ${actionText}:</p>
        <div style="text-align: center; margin: 25px 0;">
          <a href="${activationUrl}" style="background-color: #00488D; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">${buttonLabel}</a>
        </div>
        <p>Or enter your 6-digit verification token manually on the activation page:</p>
        <div style="background-color: #F0F4F8; padding: 15px; border-radius: 8px; text-align: center; margin: 15px 0;">
          <span style="font-size: 28px; font-weight: bold; letter-spacing: 4px; color: #00488D;">${escapeHtml(token)}</span>
        </div>
        <p>This verification link and token are valid for 24 hours. For security, never share them with anyone.</p>
        <p>Regards,<br />Laboratory Department</p>
      </div>
    `,
    });
};
exports.sendPatientActivationEmail = sendPatientActivationEmail;
const sendPatientReportAvailableEmail = async (to, patientName, reportId, testNames) => {
    if (!isSmtpConfigured()) {
        console.warn(`[dev] SMTP not configured - Report available notification for ${to} (Report: ${reportId})`);
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
exports.sendPatientReportAvailableEmail = sendPatientReportAvailableEmail;
