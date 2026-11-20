import { Request, Response, NextFunction } from "express";
import prisma from "../../config/prisma";

export interface AuthenticatedPatientRequest extends Request {
  patientId: string;
  patientRecord: any;
}

export const authorizePatient = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const authUser = (req as any).user;
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
    let patient = await prisma.patient_bio_data.findFirst({
      where: { user_id: authUser.user_id },
      include: {
        branch: true,
      },
    });

    // If user_id wasn't populated on patient_bio_data but username is patient_id, link it
    if (!patient && authUser.username) {
      patient = await prisma.patient_bio_data.findFirst({
        where: { patient_id: authUser.username },
        include: { branch: true },
      });
      if (patient && !patient.user_id) {
        await prisma.patient_bio_data.update({
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
    (req as AuthenticatedPatientRequest).patientId = patient.patient_id;
    (req as AuthenticatedPatientRequest).patientRecord = patient;

    return next();
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      message: "Authorization check failed: " + error.message,
    });
  }
};
