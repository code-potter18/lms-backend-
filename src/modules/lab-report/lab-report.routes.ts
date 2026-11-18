import { Router } from "express";
import { LabReportController } from "./lab-report.controller";
import { authenticate } from "../auth/auth.middleware";
import { authorize } from "../../middleware/authorize";
import { branchScope } from "../../middleware/branchScope";

const router = Router();
const controller = new LabReportController();

/* WhatsApp delivery is retained but disabled unless explicitly enabled.
   When the flag is off these routes are never registered and the whole
   /whatsapp subtree answers 404, so WhatsApp endpoints cannot send messages
   even if called directly. */
const whatsappEnabled = process.env.WHATSAPP_ENABLED === "true";

if (whatsappEnabled) {
  router.get("/whatsapp/webhook", (req, res) => controller.verifyWhatsAppWebhook(req, res));
  router.post("/whatsapp/webhook", (req, res) => controller.receiveWhatsAppWebhook(req, res));
} else {
  router.use("/whatsapp", (_req, res) =>
    res.status(404).json({ success: false, message: "WhatsApp delivery is disabled." }),
  );
}

// Every lab report route needs a logged-in user.
router.use(authenticate);

router.get("/transfer-queue", authorize("lab_report.email.send"), branchScope, (req, res) => controller.getTransferQueue(req, res));
router.get("/", (req, res) => controller.getAll(req, res));
router.post("/", (req, res) => controller.create(req, res));
router.get("/order/:orderId", (req, res) => controller.getByOrderId(req, res));
router.get("/:id/email", authorize("lab_report.email.send"), (req, res) => controller.getEmailRecipient(req, res));
router.post("/:id/email", authorize("lab_report.email.send"), (req, res) => controller.sendEmailReport(req, res));
if (whatsappEnabled) {
  router.get("/:id/whatsapp", (req, res) => controller.getWhatsAppRecipient(req, res));
  router.post("/:id/whatsapp", (req, res) => controller.sendWhatsAppReport(req, res));
}
router.get("/:id", (req, res) => controller.getById(req, res));
router.put("/:id/transfer", (req, res) => controller.transfer(req, res));
router.put("/:id", (req, res) => controller.update(req, res));
router.delete("/:id", (req, res) => controller.delete(req, res));

export default router;
