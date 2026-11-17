import { Router } from "express";
import { PatientController } from "./patient.controller";
import { authenticate } from "../auth/auth.middleware";
import { authorize } from "../../middleware/authorize";
import { branchScope } from "../../middleware/branchScope";
import {
    checkPatientContactDuplicatesValidation,
    createPatientValidation,
    updatePatientValidation,
    updatePatientEmailValidation,
    createPatientHistoryValidation
} from "./patient.validation";

const router = Router();

const controller = new PatientController();

router.post(
    "/check-duplicates",
    authenticate,
    authorize("patient.read"),
    branchScope,
    checkPatientContactDuplicatesValidation,
    controller.checkContactDuplicates.bind(controller)
);

router.post(
    "/create",
    authenticate,
    authorize("patient.create"),
    createPatientValidation,
    controller.createPatient.bind(controller)
);

router.get("/", authenticate, authorize("patient.read"), branchScope, controller.getPatients.bind(controller));

router.get(
    "/:patientId",
    authenticate,
    authorize("patient.read"),
    controller.getPatientById.bind(controller)
);

router.put(
    "/:patientId/email",
    authenticate,
    authorize("patient.update"),
    updatePatientEmailValidation,
    controller.updatePatientEmail.bind(controller)
);

router.put(
    "/:patientId",
    authenticate,
    authorize("patient.update"),
    updatePatientValidation,
    controller.updatePatient.bind(controller)
);

router.post(
    "/history",
    authenticate,
    authorize("patient.update"),
    createPatientHistoryValidation,
    controller.createPatientHistory.bind(controller)
);

export default router;
