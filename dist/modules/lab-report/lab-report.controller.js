"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LabReportController = void 0;
const lab_report_service_1 = require("./lab-report.service");
const prisma_1 = __importDefault(require("../../config/prisma"));
const lab_report_whatsapp_service_1 = require("./lab-report-whatsapp.service");
const lab_report_email_service_1 = require("./lab-report-email.service");
const service = new lab_report_service_1.LabReportService();
class LabReportController {
    async getEmailRecipient(req, res) {
        try {
            const recipient = await lab_report_email_service_1.labReportEmailService.getRecipient(String(req.params.id));
            return res.json({ success: true, data: recipient });
        }
        catch (error) {
            return res.status(400).json({
                success: false,
                message: error instanceof Error ? error.message : "Could not load email recipient.",
            });
        }
    }
    async sendEmailReport(req, res) {
        try {
            const actorId = req.user?.user_id;
            if (typeof actorId !== "string") {
                return res.status(401).json({
                    success: false,
                    message: "The authenticated user cannot be recorded for email consent.",
                });
            }
            const state = await lab_report_email_service_1.labReportEmailService.sendReport(String(req.params.id), req.body?.consentConfirmed === true, actorId);
            return res.json({ success: true, data: state });
        }
        catch (error) {
            return res.status(400).json({
                success: false,
                message: error instanceof Error ? error.message : "Lab report email send failed.",
            });
        }
    }
    async getWhatsAppRecipient(req, res) {
        try {
            const recipient = await lab_report_whatsapp_service_1.labReportWhatsAppService.getRecipient(String(req.params.id));
            return res.json({ success: true, data: recipient });
        }
        catch (error) {
            return res.status(400).json({
                success: false,
                message: error instanceof Error ? error.message : "Could not load WhatsApp recipient.",
            });
        }
    }
    async sendWhatsAppReport(req, res) {
        try {
            const actorId = req.user?.user_id;
            if (typeof actorId !== "string") {
                return res.status(401).json({
                    success: false,
                    message: "The authenticated user cannot be recorded for WhatsApp consent.",
                });
            }
            const state = await lab_report_whatsapp_service_1.labReportWhatsAppService.sendReport(String(req.params.id), req.body?.consentConfirmed === true, actorId);
            return res.json({ success: true, data: state });
        }
        catch (error) {
            return res.status(400).json({
                success: false,
                message: error instanceof Error ? error.message : "WhatsApp report send failed.",
            });
        }
    }
    async verifyWhatsAppWebhook(req, res) {
        const mode = req.query["hub.mode"];
        const token = req.query["hub.verify_token"];
        const challenge = req.query["hub.challenge"];
        if (mode === "subscribe" &&
            token === process.env.WHATSAPP_VERIFY_TOKEN &&
            typeof challenge === "string") {
            return res.status(200).send(challenge);
        }
        return res.sendStatus(403);
    }
    async receiveWhatsAppWebhook(req, res) {
        const rawBody = req.rawBody;
        const signature = req.header("x-hub-signature-256");
        if (!rawBody || !lab_report_whatsapp_service_1.labReportWhatsAppService.verifyWebhookSignature(rawBody, signature)) {
            return res.sendStatus(401);
        }
        await lab_report_whatsapp_service_1.labReportWhatsAppService.updateWebhookStatuses(req.body);
        return res.sendStatus(200);
    }
    async setAuthenticatedApprover(req, data) {
        const comment = typeof data.report_comment === "string"
            ? (() => {
                try {
                    return JSON.parse(data.report_comment);
                }
                catch {
                    return {};
                }
            })()
            : data.report_comment;
        const decision = String(data.overall_decision ?? comment?.overallDecision ?? "").toUpperCase();
        const approvalRequested = decision === "APPROVED" ||
            data.approved_by !== undefined ||
            data.approved_datetime !== undefined;
        if (!approvalRequested)
            return data;
        if (decision && decision !== "APPROVED") {
            throw new Error("Only approved reports can record an approving employee");
        }
        const authUser = req.user;
        const role = String(authUser?.role ?? "").toUpperCase();
        if (!["DOCTOR", "HEAD_ADMIN", "SUPER_ADMIN", "BRANCH_ADMIN", "ADMIN"].includes(role)) {
            throw new Error("Only an authorized clinician or administrator can approve a report");
        }
        if (typeof authUser?.user_id !== "string") {
            throw new Error("The authenticated user cannot be linked to an employee record");
        }
        const employee = await prisma_1.default.employees.findUnique({
            where: { user_id: authUser.user_id },
            select: { employee_id: true },
        });
        if (!employee) {
            throw new Error("The approving user is not linked to an employee record");
        }
        return {
            ...data,
            approved_by: employee.employee_id,
            approved_datetime: new Date().toISOString(),
        };
    }
    async getAll(req, res) {
        try {
            const reports = await service.getAll();
            return res.json({
                success: true,
                data: reports,
            });
        }
        catch (error) {
            return res.status(500).json({
                success: false,
                message: error.message,
            });
        }
    }
    async getById(req, res) {
        try {
            const id = String(req.params.id);
            const report = await service.getById(id);
            return res.json({
                success: true,
                data: report,
            });
        }
        catch (error) {
            return res.status(404).json({
                success: false,
                message: error.message,
            });
        }
    }
    async getByOrderId(req, res) {
        try {
            const orderId = String(req.params.orderId);
            const report = await service.getByOrderId(orderId);
            return res.json({
                success: true,
                data: report,
            });
        }
        catch (error) {
            return res.status(404).json({
                success: false,
                message: error.message,
            });
        }
    }
    async create(req, res) {
        try {
            const { lab_order_id } = req.body;
            if (!lab_order_id) {
                return res.status(400).json({
                    success: false,
                    message: "lab_order_id is required",
                });
            }
            const approvalData = await this.setAuthenticatedApprover(req, req.body);
            const report = await service.create(approvalData);
            return res.status(201).json({
                success: true,
                message: "Report created and saved successfully",
                data: report,
            });
        }
        catch (error) {
            const status = /authorized clinician|authenticated user|employee record/i.test(error.message)
                ? 403
                : 400;
            return res.status(status).json({
                success: false,
                message: error.message,
            });
        }
    }
    async update(req, res) {
        try {
            const id = String(req.params.id);
            const approvalData = await this.setAuthenticatedApprover(req, req.body);
            const updated = await service.update(id, approvalData);
            return res.json({
                success: true,
                message: "Report updated successfully",
                data: updated,
            });
        }
        catch (error) {
            const status = /authorized clinician|authenticated user|employee record/i.test(error.message)
                ? 403
                : 400;
            return res.status(status).json({
                success: false,
                message: error.message,
            });
        }
    }
    async transfer(req, res) {
        try {
            const id = String(req.params.id);
            const { delivered_to } = req.body;
            if (!delivered_to) {
                return res.status(400).json({
                    success: false,
                    message: "delivered_to recipient is required for transfer",
                });
            }
            const transferred = await service.transfer(id, req.body);
            return res.json({
                success: true,
                message: "Report transferred and dispatched successfully",
                data: transferred,
            });
        }
        catch (error) {
            return res.status(400).json({
                success: false,
                message: error.message,
            });
        }
    }
    async delete(req, res) {
        try {
            const id = String(req.params.id);
            await service.delete(id);
            return res.json({
                success: true,
                message: "Report deleted successfully",
            });
        }
        catch (error) {
            return res.status(400).json({
                success: false,
                message: error.message,
            });
        }
    }
}
exports.LabReportController = LabReportController;
