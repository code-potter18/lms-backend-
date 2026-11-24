"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthService = void 0;
const auth_repository_1 = require("./auth.repository");
const bcrypt_1 = require("../../utils/bcrypt");
const jwt_1 = require("../../utils/jwt");
const prisma_1 = __importDefault(require("../../config/prisma"));
const idGenerator_1 = require("../../utils/idGenerator");
const crypto_1 = __importStar(require("crypto"));
const mail_1 = require("../../utils/mail");
const roles_1 = require("../../permissions/roles");
const patient_portal_service_1 = require("../patient-portal/patient-portal.service");
class AuthService {
    authRepository = new auth_repository_1.AuthRepository();
    assertAccountUsable(user) {
        const role = user.role_type;
        const employee = user.employees;
        // Patients have patient profiles, not employee profiles.
        if (role?.toUpperCase() === "PATIENT") {
            if (!user.patient_bio_data || user.patient_bio_data.length === 0) {
                throw new Error("Patient profile not found. Please contact the administrator.");
            }
            if (user.user_status === 2) {
                throw new Error("Your account is pending activation. Please check your email for the activation link or activate your account.");
            }
            return;
        }
        const isTopLevelAdmin = roles_1.TOP_LEVEL_ADMIN_ROLES.some((r) => r.toLowerCase() === String(role ?? "").toLowerCase());
        if (!isTopLevelAdmin) {
            if (!employee) {
                throw new Error("Employee profile not found. Please contact the administrator.");
            }
            if (employee.emp_status !== true) {
                throw new Error("Account is inactive. Please contact your administrator.");
            }
            const activeMappings = user.user_branch_mapping?.filter((m) => m.status === 1 && m.branch?.branch_status === "Active");
            if (!activeMappings || activeMappings.length === 0) {
                throw new Error("No active branch has been assigned to your account. Please contact the Head Admin.");
            }
        }
    }
    resolveEmail(user) {
        if (user.role_type === "PATIENT") {
            return user.patient_bio_data?.[0]?.patient_email ?? undefined;
        }
        return user.employees?.email ?? undefined;
    }
    buildAuthPayload(user, rememberMe = false) {
        const employee = user.employees;
        // user_branch_mapping (already filtered to status: 1 by findUserByUsername)
        // is the authoritative record of which branch this user is on. For
        // DOCTORs the mapping is the ONLY source of branch truth -
        // employees.branch_id/user_table.branch_id are denormalized copies that
        // can drift out of sync and are deliberately ignored. Patients use their
        // own profile's branch; other employee roles may fall back to denormalized
        // branch columns when there's no active mapping.
        const primaryMapping = user.user_branch_mapping?.[0];
        const patient = user.patient_bio_data?.[0];
        const roleType = String(user.role_type ?? "").toUpperCase();
        const isDoctor = roleType === "DOCTOR";
        const primaryBranch = isDoctor
            ? primaryMapping?.branch ?? null
            : roleType === "PATIENT"
                ? patient?.branch || primaryMapping?.branch || user.branch || null
                : primaryMapping?.branch || employee?.branch || user.branch || null;
        const primaryBranchId = isDoctor
            ? primaryMapping?.branch_id ?? null
            : roleType === "PATIENT"
                ? patient?.branch_id || primaryMapping?.branch_id || user.branch_id || null
                : primaryMapping?.branch_id || employee?.branch_id || user.branch_id || null;
        const token = (0, jwt_1.generateToken)({
            username: user.username,
            role: user.role_type,
            user_id: user.user_id,
            employee_id: employee?.employee_id ?? null,
            hospital_id: primaryBranch?.hospital_id,
        }, rememberMe);
        return {
            token,
            user: {
                user_id: user.user_id,
                username: user.username,
                role: user.role_type,
                role_type: user.role_type,
                patient_id: patient?.patient_id ?? null,
                employee_id: employee?.employee_id ?? null,
                hospital_id: primaryBranch?.hospital_id,
                branch_id: primaryBranchId,
                branch_name: primaryBranch?.branch_name || null,
                branch_area: primaryBranch?.branch_area || null,
                emp_status: employee?.emp_status ?? null,
            },
        };
    }
    // ---- KPI Preferences ----
    static ALLOWED_KPI_IDS = new Set([
        "doctors",
        "patients",
        "critical-patients",
        "staff",
        "appointments",
        "prescriptions",
        "bills",
        "total-op",
        "chemo-delivered",
        "chemo-cancelled",
        "lab-visits",
        "ipd-patients",
        "beds-occupied",
    ]);
    validateKpiIds(kpis) {
        return kpis.filter((id) => AuthService.ALLOWED_KPI_IDS.has(id));
    }
    async getKpiPreferences(userId) {
        const user = await this.authRepository.findUserById(userId);
        if (!user?.kpi_preferences) {
            return [];
        }
        return this.validateKpiIds(user.kpi_preferences.split(",").map((s) => s.trim()).filter(Boolean));
    }
    async saveKpiPreferences(userId, kpis) {
        const validated = this.validateKpiIds(kpis);
        const value = validated.length > 0 ? validated.join(",") : null;
        await this.authRepository.updateKpiPreferences(userId, value);
        return validated;
    }
    async getKpiUsage(userId) {
        const user = await this.authRepository.findUserById(userId);
        if (!user?.kpi_usage) {
            return {};
        }
        const usage = {};
        for (const pair of user.kpi_usage.split(",")) {
            const [id, count] = pair.split(":");
            const trimmedId = id?.trim();
            const parsed = Number(count);
            if (trimmedId && AuthService.ALLOWED_KPI_IDS.has(trimmedId) && Number.isFinite(parsed) && parsed > 0) {
                usage[trimmedId] = Math.floor(parsed);
            }
        }
        return usage;
    }
    async saveKpiUsage(userId, usage) {
        const validated = {};
        for (const id of this.validateKpiIds(Object.keys(usage))) {
            const count = Math.floor(Number(usage[id]));
            if (Number.isFinite(count) && count > 0) {
                validated[id] = count;
            }
        }
        const value = Object.keys(validated).length > 0
            ? Object.entries(validated).map(([id, count]) => `${id}:${count}`).join(",")
            : null;
        await this.authRepository.updateKpiUsage(userId, value);
        return validated;
    }
    async login(username, password, rememberMe) {
        const user = await this.authRepository.findUserByUsername(username);
        if (!user) {
            throw new Error("Invalid username or password");
        }
        if (user.role_type?.toUpperCase() === "PATIENT" && user.user_status === 2) {
            throw new Error("Your account is pending activation. Please check your email for the activation link or activate your account.");
        }
        const passwordMatched = await (0, bcrypt_1.comparePassword)(password, user.password);
        if (!passwordMatched) {
            throw new Error("Invalid username or password");
        }
        this.assertAccountUsable(user);
        // OTP flow temporarily disabled - logging in directly after password check
        // return {
        //   username: user.username,
        // };
        return this.buildAuthPayload(user, rememberMe);
    }
    async sendOtp(username) {
        const user = await this.authRepository.findUserByUsername(username);
        if (!user) {
            throw new Error("User not found");
        }
        this.assertAccountUsable(user);
        const email = this.resolveEmail(user);
        if (!email) {
            throw new Error("Email address not found");
        }
        const otp = (0, crypto_1.randomInt)(100000, 999999).toString();
        const expiry = new Date(Date.now() + 5 * 60 * 1000);
        // Generate and insert in one transaction: if the insert fails the id is
        // not consumed, keeping id_sequences aligned with the data.
        await prisma_1.default.$transaction(async (tx) => {
            const id = await (0, idGenerator_1.generateId)(tx, "LOGIN_OTP");
            await tx.login_otp.create({
                data: {
                    otp_id: id,
                    user_id: user.user_id,
                    user_type: user.role_type === "PATIENT" ? "PATIENT" : "EMPLOYEE",
                    otp_code: otp,
                    expires_at: expiry
                }
            });
        });
        await (0, mail_1.sendOtpEmail)(email, otp);
        return {
            message: `OTP sent to ${email.replace(/^(.{2}).*(@.*)$/, "$1***$2")}`,
        };
    }
    async verifyOtp(username, code, rememberMe = false) {
        const user = await this.authRepository.findUserByUsername(username);
        if (!user) {
            throw new Error("User not found");
        }
        // OTP verification temporarily disabled
        // const otpRecord = await prisma.login_otp.findFirst({
        //   where: {
        //     user_id: user.user_id!,
        //     is_verified: false
        //   },
        //   orderBy: {
        //     created_at: "desc"
        //   }
        // });
        // if (!otpRecord) {
        //   throw new Error("OTP not found. Please request a new one.");
        // }
        // if (otpRecord.otp_code !== code) {
        //   throw new Error("Invalid OTP");
        // }
        // if (otpRecord.expires_at < new Date()) {
        //   throw new Error("OTP has expired");
        // }
        // await prisma.login_otp.update({
        //   where: {
        //     id: otpRecord.id
        //   },
        //   data: {
        //     is_verified: true
        //   }
        // });
        return this.buildAuthPayload(user, rememberMe);
    }
    async requestPatientActivation(identifier, mode) {
        const trimmed = (identifier || "").trim();
        if (!trimmed) {
            throw new Error("Patient ID or email is required");
        }
        let user = await this.authRepository.findUserByUsername(trimmed);
        if (!user) {
            const patient = await prisma_1.default.patient_bio_data.findFirst({
                where: {
                    OR: [
                        { patient_id: { equals: trimmed, mode: "insensitive" } },
                        { patient_email: { equals: trimmed, mode: "insensitive" } },
                    ],
                },
            });
            if (!patient || !patient.patient_id) {
                throw new Error("No patient record found matching that Patient ID or email.");
            }
            if (patient.user_id) {
                user = await this.authRepository.findUserById(patient.user_id);
            }
            if (!user) {
                const defaultHash = await (0, bcrypt_1.hashPassword)(Math.random().toString(36));
                await prisma_1.default.$transaction(async (tx) => {
                    const userId = await (0, idGenerator_1.generateId)(tx, "USER");
                    await tx.user_table.create({
                        data: {
                            user_id: userId,
                            username: patient.patient_id,
                            password: defaultHash,
                            role_type: "PATIENT",
                            created_by: "SYSTEM_ACTIVATION",
                            branch_id: patient.branch_id,
                            user_status: 2,
                        },
                    });
                    await tx.patient_bio_data.update({
                        where: { id: patient.id },
                        data: { user_id: userId },
                    });
                });
                user = await this.authRepository.findUserByUsername(patient.patient_id);
            }
        }
        if (!user) {
            throw new Error("User account could not be resolved");
        }
        if (user.role_type?.toUpperCase() !== "PATIENT") {
            throw new Error("Activation is only available for Patient accounts.");
        }
        const patient = user.patient_bio_data?.[0];
        const email = patient?.patient_email;
        const patientName = [patient?.patient_first_name, patient?.patient_last_name].filter(Boolean).join(" ") || "Patient";
        const isPending = user.user_status === 2;
        // Requirement 4 & 5: When an ACTIVE patient clicks "Set your password & activate your account",
        // do not show the password setup form again. Show a message explaining that the account is already
        // activated and direct them to normal login. Only genuinely pending accounts can complete activation.
        if (!isPending && mode !== "reset") {
            return {
                success: true,
                isAlreadyActive: true,
                message: "Your account is already active. Please log in using your username and password. If you forgot your password, use the Forgot Password option on the login page.",
                patientId: patient?.patient_id,
                username: user.username,
            };
        }
        // Rate limit: 60 seconds cooldown between verification token requests
        const recentOtp = await prisma_1.default.login_otp.findFirst({
            where: {
                user_id: user.user_id,
                user_type: { in: ["PATIENT_ACTIVATION", "PASSWORD_RESET"] },
                created_at: {
                    gte: new Date(Date.now() - 60 * 1000),
                },
            },
            orderBy: { created_at: "desc" },
        });
        if (recentOtp && recentOtp.created_at) {
            const elapsedSeconds = Math.floor((Date.now() - new Date(recentOtp.created_at).getTime()) / 1000);
            if (elapsedSeconds < 60) {
                const remainingSeconds = 60 - elapsedSeconds;
                throw new Error(`Please wait ${remainingSeconds} second${remainingSeconds === 1 ? "" : "s"} before requesting another verification code.`);
            }
        }
        await prisma_1.default.login_otp.updateMany({
            where: {
                user_id: user.user_id,
                user_type: { in: ["PATIENT_ACTIVATION", "PASSWORD_RESET"] },
                is_verified: false,
            },
            data: { is_verified: true },
        });
        const tokenType = isPending ? "PATIENT_ACTIVATION" : "PASSWORD_RESET";
        const token = (0, crypto_1.randomInt)(100000, 999999).toString();
        const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await prisma_1.default.$transaction(async (tx) => {
            const otpId = await (0, idGenerator_1.generateId)(tx, "LOGIN_OTP");
            await tx.login_otp.create({
                data: {
                    otp_id: otpId,
                    user_id: user.user_id,
                    user_type: tokenType,
                    otp_code: token,
                    expires_at: expiry,
                },
            });
        });
        if (email) {
            await (0, mail_1.sendPatientActivationEmail)(email, patientName, token, patient?.patient_id || undefined, user.username || undefined, !isPending).catch((e) => {
                console.warn("Could not send activation email:", e.message);
            });
        }
        const emailMasked = email ? email.replace(/^(.{2}).*(@.*)$/, "$1***$2") : null;
        return {
            success: true,
            isAlreadyActive: false,
            message: emailMasked
                ? `A verification code has been sent to your registered email address (${emailMasked}).`
                : "A verification code has been sent to your registered email address.",
            emailMasked,
            patientId: patient?.patient_id,
            username: user.username,
        };
    }
    async verifyPatientToken(data) {
        const { identifier, token } = data;
        const trimmedId = (identifier || "").trim();
        const trimmedToken = (token || "").trim();
        if (!trimmedId || !trimmedToken) {
            throw new Error("Identifier and verification code are required.");
        }
        const user = await this.authRepository.findUserByUsername(trimmedId);
        if (!user) {
            throw new Error("Patient user account not found.");
        }
        const isPending = user.user_status === 2;
        const otpRecord = await prisma_1.default.login_otp.findFirst({
            where: {
                user_id: user.user_id,
                user_type: { in: ["PATIENT_ACTIVATION", "PASSWORD_RESET"] },
                otp_code: trimmedToken,
                is_verified: false,
            },
            orderBy: { created_at: "desc" },
        });
        if (!otpRecord) {
            const alreadyUsed = await prisma_1.default.login_otp.findFirst({
                where: {
                    user_id: user.user_id,
                    otp_code: trimmedToken,
                    is_verified: true,
                },
            });
            if (alreadyUsed) {
                throw new Error("This verification token has already been used. Please request a new code.");
            }
            throw new Error("Invalid verification code. Please check the code and try again.");
        }
        if (otpRecord.expires_at < new Date()) {
            throw new Error("Verification code has expired. Please request a new one.");
        }
        if (otpRecord.user_type === "PATIENT_ACTIVATION" && !isPending) {
            throw new Error("This account has already been activated. Please log in using your username and password.");
        }
        return {
            success: true,
            message: "Verification code confirmed successfully.",
        };
    }
    async setupPatientPassword(data) {
        const { identifier, token, newPassword } = data;
        const trimmedId = (identifier || "").trim();
        const trimmedToken = (token || "").trim();
        if (!trimmedId || !trimmedToken || !newPassword) {
            throw new Error("Identifier, verification token, and new password are required.");
        }
        if (newPassword.length < 8) {
            throw new Error("Password must be at least 8 characters long.");
        }
        if (!/[A-Z]/.test(newPassword)) {
            throw new Error("Password must contain at least one uppercase letter.");
        }
        if (!/[a-z]/.test(newPassword)) {
            throw new Error("Password must contain at least one lowercase letter.");
        }
        if (!/[0-9]/.test(newPassword)) {
            throw new Error("Password must contain at least one number.");
        }
        if (!/[!@#$%^&*(),.?":{}|<>]/.test(newPassword)) {
            throw new Error("Password must contain at least one special character.");
        }
        const user = await this.authRepository.findUserByUsername(trimmedId);
        if (!user) {
            throw new Error("Patient user account not found.");
        }
        const isPending = user.user_status === 2;
        const otpRecord = await prisma_1.default.login_otp.findFirst({
            where: {
                user_id: user.user_id,
                user_type: { in: ["PATIENT_ACTIVATION", "PASSWORD_RESET"] },
                otp_code: trimmedToken,
                is_verified: false,
            },
            orderBy: { created_at: "desc" },
        });
        if (!otpRecord) {
            // Check if this token was already verified/used
            const alreadyUsed = await prisma_1.default.login_otp.findFirst({
                where: {
                    user_id: user.user_id,
                    otp_code: trimmedToken,
                    is_verified: true,
                },
            });
            if (alreadyUsed) {
                throw new Error("This verification token has already been used. Please log in with your password or request a new code.");
            }
            throw new Error("Invalid verification token. Please check the code or request a new one.");
        }
        if (otpRecord.expires_at < new Date()) {
            throw new Error("Verification token has expired. Please request a new one.");
        }
        // Requirement 5: Only genuinely pending accounts can complete activation
        if (otpRecord.user_type === "PATIENT_ACTIVATION" && !isPending) {
            throw new Error("This account has already been activated. Please log in using your username and password.");
        }
        const hashedPassword = await (0, bcrypt_1.hashPassword)(newPassword);
        await prisma_1.default.$transaction(async (tx) => {
            await tx.user_table.update({
                where: { id: user.id },
                data: {
                    password: hashedPassword,
                    user_status: 1,
                },
            });
            await tx.login_otp.update({
                where: { id: otpRecord.id },
                data: { is_verified: true },
            });
        });
        if (String(user.role_type || "").toUpperCase() === "PATIENT") {
            const patient = await prisma_1.default.patient_bio_data.findFirst({
                where: { user_id: user.user_id },
                select: { patient_id: true },
            });
            const resolvedPatientId = patient?.patient_id || user.username;
            if (resolvedPatientId) {
                const opId = `RESET_${crypto_1.default.randomUUID()}`;
                const eventKey = `PASSWORD_CHANGED:${resolvedPatientId}:${opId}`;
                try {
                    await patient_portal_service_1.PatientPortalService.createNotification(resolvedPatientId, "Password Changed", "Your account password has been changed successfully.", "PASSWORD_CHANGED", opId, eventKey);
                }
                catch (e) {
                    console.warn("Could not record password change notification:", e.message);
                }
            }
        }
        return {
            success: true,
            message: "Password set successfully! You can now log in using your username, Patient ID, or email.",
        };
    }
    // Self-service only - the caller can only ever change their own username,
    // never someone else's (userId comes from the authenticated JWT, not
    // request input). No cooldown period for now.
    async changeUsername(userId, newUsername) {
        const trimmed = newUsername.trim();
        if (!trimmed) {
            throw new Error("New username is required");
        }
        const existing = await this.authRepository.findUserByUsername(trimmed);
        if (existing && existing.user_id !== userId) {
            throw new Error("Username already exists");
        }
        const user = await this.authRepository.findUserById(userId);
        if (!user) {
            throw new Error("User not found");
        }
        await prisma_1.default.user_table.update({
            where: { id: user.id },
            data: { username: trimmed },
        });
        return { username: trimmed };
    }
    // Self-service only, same as changeUsername - requires the current
    // password to be re-entered, and userId always comes from the JWT.
    async changePassword(userId, oldPassword, newPassword, operationId) {
        const user = await this.authRepository.findUserById(userId);
        if (!user) {
            throw new Error("User not found");
        }
        const passwordMatched = await (0, bcrypt_1.comparePassword)(oldPassword, user.password);
        if (!passwordMatched) {
            throw new Error("Current password is incorrect");
        }
        if (!newPassword || newPassword.length < 6) {
            throw new Error("New password must be at least 6 characters");
        }
        const hashed = await (0, bcrypt_1.hashPassword)(newPassword);
        await prisma_1.default.user_table.update({
            where: { id: user.id },
            data: { password: hashed },
        });
        if (String(user.role_type || "").toUpperCase() === "PATIENT") {
            const patient = await prisma_1.default.patient_bio_data.findFirst({
                where: { user_id: user.user_id },
                select: { patient_id: true },
            });
            const resolvedPatientId = patient?.patient_id || user.username;
            if (resolvedPatientId) {
                const opId = operationId || `OP_${crypto_1.default.randomUUID()}`;
                const stableRef = `CHG_${opId}`;
                const eventKey = `PASSWORD_CHANGED:${resolvedPatientId}:${stableRef}`;
                patient_portal_service_1.PatientPortalService.createNotification(resolvedPatientId, "Password Changed", "Your account password has been changed successfully.", "PASSWORD_CHANGED", stableRef, eventKey).catch(() => { });
            }
        }
        return { message: "Password updated successfully" };
    }
}
exports.AuthService = AuthService;
