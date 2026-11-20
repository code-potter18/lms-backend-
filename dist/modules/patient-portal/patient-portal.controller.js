"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PatientPortalController = void 0;
const patient_portal_service_1 = require("./patient-portal.service");
const service = new patient_portal_service_1.PatientPortalService();
class PatientPortalController {
    async getProfile(req, res) {
        try {
            const data = await service.getProfile(req.patientId);
            return res.status(200).json({ success: true, data });
        }
        catch (error) {
            return res.status(400).json({ success: false, message: error.message });
        }
    }
    async updateProfile(req, res) {
        try {
            const result = await service.updateProfile(req.patientId, req.body);
            return res.status(200).json(result);
        }
        catch (error) {
            return res.status(400).json({ success: false, message: error.message });
        }
    }
    async getDashboard(req, res) {
        try {
            const data = await service.getDashboard(req.patientId);
            return res.status(200).json({ success: true, data });
        }
        catch (error) {
            return res.status(400).json({ success: false, message: error.message });
        }
    }
    async getLabTests(req, res) {
        try {
            const { search, status } = req.query;
            const data = await service.getLabTests(req.patientId, { search, status });
            return res.status(200).json({ success: true, data });
        }
        catch (error) {
            return res.status(400).json({ success: false, message: error.message });
        }
    }
    async getTestStatus(req, res) {
        try {
            const data = await service.getTestStatus(req.patientId);
            return res.status(200).json({ success: true, data });
        }
        catch (error) {
            return res.status(400).json({ success: false, message: error.message });
        }
    }
    async getReports(req, res) {
        try {
            const data = await service.getApprovedReports(req.patientId);
            return res.status(200).json({ success: true, data });
        }
        catch (error) {
            return res.status(400).json({ success: false, message: error.message });
        }
    }
    async downloadReportPdf(req, res) {
        try {
            const id = String(req.params.id);
            const result = await service.getReportPdf(req.patientId, id);
            const rawPdf = result.pdfData;
            // Handle base64 encoded data URI or raw base64 string
            let base64Clean = rawPdf;
            if (rawPdf.includes("base64,")) {
                base64Clean = rawPdf.split("base64,")[1];
            }
            base64Clean = base64Clean.trim();
            const pdfBuffer = Buffer.from(base64Clean, "base64");
            const disposition = req.query.disposition === "inline" ? "inline" : "attachment";
            res.setHeader("Content-Type", "application/pdf");
            res.setHeader("Content-Disposition", `${disposition}; filename="LabReport-${result.reportId}.pdf"`);
            res.setHeader("Content-Length", pdfBuffer.length);
            return res.end(pdfBuffer);
        }
        catch (error) {
            const status = error.message === "Report not found" ? 404 : 403;
            return res.status(status).json({ success: false, message: error.message });
        }
    }
    async viewReportPdf(req, res) {
        try {
            const id = String(req.params.id);
            const result = await service.getReportPdf(req.patientId, id);
            return res.status(200).json({
                success: true,
                data: {
                    reportId: result.reportId,
                    orderId: result.orderId,
                    pdfBase64: result.pdfData,
                },
            });
        }
        catch (error) {
            const status = error.message === "Report not found" ? 404 : 403;
            return res.status(status).json({ success: false, message: error.message });
        }
    }
    async getNotifications(req, res) {
        try {
            const data = await service.getNotifications(req.patientId);
            return res.status(200).json({ success: true, data });
        }
        catch (error) {
            return res.status(400).json({ success: false, message: error.message });
        }
    }
    async markNotificationRead(req, res) {
        try {
            const id = String(req.params.id);
            await service.markNotificationRead(req.patientId, id);
            return res.status(200).json({ success: true, message: "Marked as read" });
        }
        catch (error) {
            return res.status(400).json({ success: false, message: error.message });
        }
    }
    async markAllNotificationsRead(req, res) {
        try {
            await service.markAllNotificationsRead(req.patientId);
            return res.status(200).json({ success: true, message: "All marked as read" });
        }
        catch (error) {
            return res.status(400).json({ success: false, message: error.message });
        }
    }
}
exports.PatientPortalController = PatientPortalController;
