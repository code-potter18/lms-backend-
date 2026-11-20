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
    async setAuthenticatedApprover(req, data, reportId) {
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
        if (!authUser) {
            throw new Error("Authentication required to approve report");
        }
        const role = String(authUser.role ?? authUser.role_type ?? "").toUpperCase();
        const isDoctorOrAdmin = [
            "DOCTOR",
            "HEAD_ADMIN",
            "SUPER_ADMIN",
            "BRANCH_ADMIN",
            "ADMIN",
        ].includes(role);
        const isLabTechnician = role === "LAB_TECHNICIAN";
        if (!isDoctorOrAdmin && !isLabTechnician) {
            throw new Error("Only an authorized clinician, administrator, or walk-in lab technician can approve a report");
        }
        // If LAB_TECHNICIAN, verify that this is an eligible standalone walk-in order
        if (isLabTechnician) {
            let targetOrderId = data.lab_order_id;
            if (!targetOrderId && reportId) {
                const existingReport = await prisma_1.default.lab_report.findUnique({
                    where: { lab_report_id: reportId },
                    select: { lab_order_id: true },
                });
                targetOrderId = existingReport?.lab_order_id;
            }
            const order = await prisma_1.default.lab_order.findFirst({
                where: {
                    OR: [
                        ...(targetOrderId ? [{ lab_order_id: targetOrderId }] : []),
                        ...(data.lab_order_item_id ? [{ lab_order_item: { some: { lab_order_item_id: data.lab_order_item_id } } }] : []),
                        ...(data.barcode ? [{ lab_order_item: { some: { sample_collection: { some: { barcode: data.barcode } } } } }] : []),
                    ],
                },
                include: {
                    lab_order_item: {
                        include: {
                            lab_result: true,
                            lab_test_master: true,
                        },
                    },
                    patient_history: {
                        include: {
                            patient_bio_data: true,
                        },
                    },
                },
            });
            if (!order) {
                throw new Error("Cannot verify lab order for technician approval");
            }
            // 1. Verify standalone walk-in order
            const isWalkIn = !order.appointment_id &&
                (/walk-?in/i.test(order.clinical_notes || "") ||
                    order.clinical_notes === "Walk-in laboratory registration");
            if (!isWalkIn) {
                throw new Error("Lab Technicians are only authorized to approve standalone walk-in laboratory reports. Doctor-referred orders require clinical doctor approval.");
            }
            // 2. Verify correct patient relationship
            const patientId = order.patient_history?.patient_id ||
                order.patient_history?.patient_bio_data?.patient_id;
            if (!patientId) {
                throw new Error("This laboratory order is not linked to a valid patient record");
            }
            // 3. Verify all required tests are completed
            const items = order.lab_order_item || [];
            if (items.length === 0) {
                throw new Error("The laboratory order has no test items");
            }
            const incompleteItems = items.filter((it) => !["COMPLETED", "REPORT GENERATED"].includes((it.item_status || "").toUpperCase()));
            if (incompleteItems.length > 0) {
                const pendingNames = incompleteItems
                    .map((it) => it.lab_test_master?.test_name || it.lab_order_item_id)
                    .join(", ");
                throw new Error(`Cannot approve incomplete order: waiting for ${pendingNames}`);
            }
            // 4. Verify all required results are available
            const missingResultItems = items.filter((it) => !it.lab_result || it.lab_result.length === 0);
            if (missingResultItems.length > 0) {
                const missingNames = missingResultItems
                    .map((it) => it.lab_test_master?.test_name || it.lab_order_item_id)
                    .join(", ");
                throw new Error(`Cannot approve order: test results missing for ${missingNames}`);
            }
        }
        // Resolve authenticated employee ID
        let employee = null;
        if (typeof authUser?.user_id === "string") {
            employee = await prisma_1.default.employees.findUnique({
                where: { user_id: authUser.user_id },
                select: { employee_id: true },
            });
        }
        if (!employee && authUser?.username) {
            employee = await prisma_1.default.employees.findFirst({
                where: {
                    user_table: { username: authUser.username },
                },
                select: { employee_id: true },
            });
        }
        // For DOCTOR/ADMIN only (optional fallback if configured):
        if (!employee && isDoctorOrAdmin && data.approved_by) {
            employee = await prisma_1.default.employees.findFirst({
                where: {
                    OR: [
                        { employee_id: data.approved_by },
                        { first_name: { contains: data.approved_by, mode: "insensitive" } },
                    ],
                },
                select: { employee_id: true },
            });
        }
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
    async getTransferQueue(req, res) {
        try {
            const branchId = typeof req.query.branchId === "string" ? req.query.branchId : undefined;
            const queue = await service.getTransferQueue(branchId);
            return res.json({ success: true, data: queue });
        }
        catch (error) {
            return res.status(500).json({
                success: false,
                message: error instanceof Error ? error.message : "Could not load approved report transfer queue.",
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
            const status = /authorized|permission|authenticated|forbidden|employee record/i.test(error.message)
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
            const status = /authorized|permission|authenticated|forbidden|employee record/i.test(error.message)
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
