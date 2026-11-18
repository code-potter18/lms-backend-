import { body } from "express-validator";

export const checkPatientContactDuplicatesValidation = [
    body("mobile")
        .isString()
        .trim()
        .notEmpty()
        .withMessage("Mobile number is required"),
    body("email")
        .optional({ nullable: true, checkFalsy: true })
        .isEmail()
        .withMessage("Valid email is required"),
];

export const createPatientValidation = [

    body("username")
        .notEmpty()
        .withMessage("Username is required"),

    body("password")
        .isLength({ min: 6 })
        .withMessage("Password should contain minimum 6 characters"),

    body("first_name")
        .notEmpty()
        .withMessage("First name is required"),

    body("mobile")
        .isMobilePhone("any")
        .withMessage("Valid mobile number is required"),

    // Every new patient must supply an email: it is the delivery address for
    // their approved laboratory report. Legacy patients without an email are
    // unaffected because this validation only runs on patient creation.
    body("email")
        .isString()
        .withMessage("Email is required")
        .bail()
        .trim()
        .notEmpty()
        .withMessage("Email is required")
        .bail()
        .isEmail()
        .withMessage("Valid email is required")
        .bail()
        .isLength({ max: 254 })
        .withMessage("Email must be 254 characters or fewer"),

    body("branch_id")
        .notEmpty()
        .withMessage("Branch is required"),

    body("created_by")
        .notEmpty()
        .withMessage("Created by is required"),

    // Referral details — required/validated only when patient_type is "Referral"
    body("referral_type")
        .if(body("patient_type").equals("Referral"))
        .notEmpty()
        .withMessage("Referral type is required for Referral patient type")
        .bail()
        .isString()
        .withMessage("Referral type must be a string")
        .bail()
        .trim()
        .isLength({ min: 1, max: 100 })
        .withMessage("Referral type must not exceed 100 characters"),

    body("referred_by")
        .if(body("patient_type").equals("Referral"))
        .notEmpty()
        .withMessage("Referred by is required for Referral patient type")
        .bail()
        .isString()
        .withMessage("Referred by must be a string")
        .bail()
        .isLength({ max: 255 })
        .withMessage("Referred by must not exceed 255 characters"),

    body("referral_contact")
        .if(body("patient_type").equals("Referral"))
        .optional({ nullable: true, checkFalsy: true })
        .isString()
        .withMessage("Referrer contact must be a string")
        .bail()
        .isLength({ max: 255 })
        .withMessage("Referrer contact must not exceed 255 characters"),

    body("referral_notes")
        .if(body("patient_type").equals("Referral"))
        .optional({ nullable: true, checkFalsy: true })
        .isString()
        .withMessage("Referral notes must be a string")
        .bail()
        .isLength({ max: 2000 })
        .withMessage("Referral notes must not exceed 2000 characters"),

];

export const updatePatientValidation = [

    body("mobile")
        .optional()
        .isMobilePhone("any")
        .withMessage("Valid mobile number is required"),

    body("email")
        .optional()
        .isEmail()
        .withMessage("Valid email is required")
        .bail()
        .isLength({ max: 254 })
        .withMessage("Email must be 254 characters or fewer"),

    // Referral details — required/validated only when patient_type is "Referral"
    body("referral_type")
        .if(body("patient_type").equals("Referral"))
        .notEmpty()
        .withMessage("Referral type is required for Referral patient type")
        .bail()
        .isString()
        .withMessage("Referral type must be a string")
        .bail()
        .trim()
        .isLength({ min: 1, max: 100 })
        .withMessage("Referral type must not exceed 100 characters"),

    body("referred_by")
        .if(body("patient_type").equals("Referral"))
        .notEmpty()
        .withMessage("Referred by is required for Referral patient type")
        .bail()
        .isString()
        .withMessage("Referred by must be a string")
        .bail()
        .isLength({ max: 255 })
        .withMessage("Referred by must not exceed 255 characters"),

    body("referral_contact")
        .if(body("patient_type").equals("Referral"))
        .optional({ nullable: true, checkFalsy: true })
        .isString()
        .withMessage("Referrer contact must be a string")
        .bail()
        .isLength({ max: 255 })
        .withMessage("Referrer contact must not exceed 255 characters"),

    body("referral_notes")
        .if(body("patient_type").equals("Referral"))
        .optional({ nullable: true, checkFalsy: true })
        .isString()
        .withMessage("Referral notes must be a string")
        .bail()
        .isLength({ max: 2000 })
        .withMessage("Referral notes must not exceed 2000 characters"),

];

export const updatePatientEmailValidation = [
    body("email")
        .isString()
        .trim()
        .notEmpty()
        .withMessage("Email is required")
        .bail()
        .isEmail()
        .withMessage("Valid email is required")
        .bail()
        .isLength({ max: 254 })
        .withMessage("Email must be 254 characters or fewer"),
];

export const createPatientHistoryValidation = [

    body("patientId")
        .notEmpty()
        .withMessage("Patient ID is required"),

    body("appointmentId")
        .optional()
        .isString()
        .withMessage("Appointment ID must be a string"),

    body("systolicBp")
        .optional()
        .isInt({ min: 0, max: 300 })
        .withMessage("Systolic BP must be between 0 and 300"),

    body("diastolicBp")
        .optional()
        .isInt({ min: 0, max: 200 })
        .withMessage("Diastolic BP must be between 0 and 200"),

    body("pulse")
        .optional()
        .isInt({ min: 0, max: 300 })
        .withMessage("Pulse must be between 0 and 300"),

    body("respiratoryRate")
        .optional()
        .isInt({ min: 0, max: 100 })
        .withMessage("Respiratory rate must be between 0 and 100"),

    body("temperature")
        .optional()
        .isFloat({ min: 20, max: 45 })
        .withMessage("Temperature must be between 20 and 45"),

    body("oxygenSaturation")
        .optional()
        .isFloat({ min: 0, max: 100 })
        .withMessage("Oxygen saturation must be between 0 and 100"),

    body("bloodSugar")
        .optional()
        .isString()
        .withMessage("Blood sugar must be a string"),

    body("weight")
        .optional()
        .isFloat({ min: 0, max: 500 })
        .withMessage("Weight must be between 0 and 500"),

    body("height")
        .optional()
        .isFloat({ min: 0, max: 300 })
        .withMessage("Height must be between 0 and 300"),

    body("painScore")
        .optional()
        .isInt({ min: 0, max: 10 })
        .withMessage("Pain score must be between 0 and 10"),

    body("severity")
        .optional()
        .isInt({ min: 0, max: 10 })
        .withMessage("Severity must be between 0 and 10"),

    body("clinicalNotes")
        .optional()
        .isString()
        .withMessage("Clinical notes must be a string"),

];
