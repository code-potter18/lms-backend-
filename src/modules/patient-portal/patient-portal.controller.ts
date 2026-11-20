import { Response } from "express";
import { AuthenticatedPatientRequest } from "./patient-portal.middleware";
import { PatientPortalService } from "./patient-portal.service";

const service = new PatientPortalService();

export class PatientPortalController {
  async getProfile(req: AuthenticatedPatientRequest, res: Response) {
    try {
      const data = await service.getProfile(req.patientId);
      return res.status(200).json({ success: true, data });
    } catch (error: any) {
      return res.status(400).json({ success: false, message: error.message });
    }
  }

  async updateProfile(req: AuthenticatedPatientRequest, res: Response) {
    try {
      const result = await service.updateProfile(req.patientId, req.body);
      return res.status(200).json(result);
    } catch (error: any) {
      return res.status(400).json({ success: false, message: error.message });
    }
  }

  async getDashboard(req: AuthenticatedPatientRequest, res: Response) {
    try {
      const data = await service.getDashboard(req.patientId);
      return res.status(200).json({ success: true, data });
    } catch (error: any) {
      return res.status(400).json({ success: false, message: error.message });
    }
  }

  async getLabTests(req: AuthenticatedPatientRequest, res: Response) {
    try {
      const { search, status } = req.query as { search?: string; status?: string };
      const data = await service.getLabTests(req.patientId, { search, status });
      return res.status(200).json({ success: true, data });
    } catch (error: any) {
      return res.status(400).json({ success: false, message: error.message });
    }
  }

  async getTestStatus(req: AuthenticatedPatientRequest, res: Response) {
    try {
      const data = await service.getTestStatus(req.patientId);
      return res.status(200).json({ success: true, data });
    } catch (error: any) {
      return res.status(400).json({ success: false, message: error.message });
    }
  }

  async getReports(req: AuthenticatedPatientRequest, res: Response) {
    try {
      const data = await service.getApprovedReports(req.patientId);
      return res.status(200).json({ success: true, data });
    } catch (error: any) {
      return res.status(400).json({ success: false, message: error.message });
    }
  }

  async downloadReportPdf(req: AuthenticatedPatientRequest, res: Response) {
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
    } catch (error: any) {
      const status = error.message === "Report not found" ? 404 : 403;
      return res.status(status).json({ success: false, message: error.message });
    }
  }

  async viewReportPdf(req: AuthenticatedPatientRequest, res: Response) {
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
    } catch (error: any) {
      const status = error.message === "Report not found" ? 404 : 403;
      return res.status(status).json({ success: false, message: error.message });
    }
  }

  async getNotifications(req: AuthenticatedPatientRequest, res: Response) {
    try {
      const data = await service.getNotifications(req.patientId);
      return res.status(200).json({ success: true, data });
    } catch (error: any) {
      return res.status(400).json({ success: false, message: error.message });
    }
  }

  async markNotificationRead(req: AuthenticatedPatientRequest, res: Response) {
    try {
      const id = String(req.params.id);
      await service.markNotificationRead(req.patientId, id);
      return res.status(200).json({ success: true, message: "Marked as read" });
    } catch (error: any) {
      return res.status(400).json({ success: false, message: error.message });
    }
  }

  async markAllNotificationsRead(req: AuthenticatedPatientRequest, res: Response) {
    try {
      await service.markAllNotificationsRead(req.patientId);
      return res.status(200).json({ success: true, message: "All marked as read" });
    } catch (error: any) {
      return res.status(400).json({ success: false, message: error.message });
    }
  }
}
