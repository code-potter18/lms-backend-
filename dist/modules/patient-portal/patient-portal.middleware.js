"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authorizePatient = void 0;
const prisma_1 = __importDefault(require("../../config/prisma"));
const authorizePatient = async (req, res, next) => {
    try {
        const authUser = req.user;
        if (!authUser || !authUser.user_id) {
            return res.status(401).json({
                success: false,
                message: "Authentication required",
            });
        }
        const role = String(authUser.role_type || authUser.role || "").trim().toUpperCase();
        if (role !== "PATIENT") {
            return res.status(403).json({
                success: false,
                message: "Access restricted to authorized patients only",
            });
        }
        // Resolve patient record strictly from authenticated user_id
        let patient = await prisma_1.default.patient_bio_data.findFirst({
            where: { user_id: authUser.user_id },
            include: {
                branch: true,
            },
        });
        // If user_id wasn't populated on patient_bio_data but username is patient_id, link it
        if (!patient && authUser.username) {
            patient = await prisma_1.default.patient_bio_data.findFirst({
                where: { patient_id: authUser.username },
                include: { branch: true },
            });
            if (patient && !patient.user_id) {
                await prisma_1.default.patient_bio_data.update({
                    where: { id: patient.id },
                    data: { user_id: authUser.user_id },
                });
            }
        }
        if (!patient || !patient.patient_id) {
            return res.status(403).json({
                success: false,
                message: "No linked patient record found for this authenticated user",
            });
        }
        // Attach strictly validated server-side patient identity
        req.patientId = patient.patient_id;
        req.patientRecord = patient;
        return next();
    }
    catch (error) {
        return res.status(500).json({
            success: false,
            message: "Authorization check failed: " + error.message,
        });
    }
};
exports.authorizePatient = authorizePatient;
