import { Router } from "express";
import { authenticate } from "../auth/auth.middleware";
import { authorizePatient } from "./patient-portal.middleware";
import { PatientPortalController } from "./patient-portal.controller";

const router = Router();
const controller = new PatientPortalController();

// All patient portal routes strictly require JWT authentication and PATIENT role authorization
router.use(authenticate);
router.use(authorizePatient as any);

router.get("/profile", controller.getProfile.bind(controller) as any);
router.put("/profile", controller.updateProfile.bind(controller) as any);
router.get("/dashboard", controller.getDashboard.bind(controller) as any);
router.get("/lab-tests", controller.getLabTests.bind(controller) as any);
router.get("/test-status", controller.getTestStatus.bind(controller) as any);
router.get("/reports", controller.getReports.bind(controller) as any);
router.get("/reports/:id/view", controller.viewReportPdf.bind(controller) as any);
router.get("/reports/:id/download", controller.downloadReportPdf.bind(controller) as any);
router.get("/notifications", controller.getNotifications.bind(controller) as any);
router.put("/notifications/mark-all-read", controller.markAllNotificationsRead.bind(controller) as any);
router.put("/notifications/:id/read", controller.markNotificationRead.bind(controller) as any);

export default router;
