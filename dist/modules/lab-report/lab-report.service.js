"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LabReportService = void 0;
const prisma_1 = __importDefault(require("../../config/prisma"));
const lab_report_repository_1 = require("./lab-report.repository");
const patient_portal_service_1 = require("../patient-portal/patient-portal.service");
const mail_1 = require("../../utils/mail");
const repository = new lab_report_repository_1.LabReportRepository();
/* report_comment is a jsonb column holding the report's comment object:
   { text, parameters, clinicalCorrelation, overallDecision }. A comment
   sent as that object's JSON string (as the report screens send it) is
   stored as the object; plain text is stored as { text }. */
const toReportComment = (value) => {
    if (value === undefined || value === null || value === "")
        return undefined;
    if (typeof value !== "string")
        return value;
    try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === "object")
            return parsed;
    }
    catch {
        // plain text
    }
    return { text: value };
};
/* The comment's text, from a stored comment object or older string. */
const reportCommentText = (value) => {
    const comment = typeof value === "string" ? toReportComment(value) : value;
    const text = comment && typeof comment === "object" ? comment.text : undefined;
    return typeof text === "string" ? text : "";
};
class LabReportService {
    async getAll() {
        return repository.findAll();
    }
    async getTransferQueue(branchId) {
        return repository.findTransferQueue(branchId);
    }
    async getById(id) {
        const report = await repository.findById(id);
        if (!report) {
            throw new Error(`Lab report with id ${id} not found`);
        }
        return report;
    }
    async getByOrderId(orderId) {
        const report = await repository.findByOrderId(orderId);
        if (!report) {
            throw new Error(`Lab report for order id ${orderId} not found`);
        }
        return report;
    }
    async resolveOrderAndItem(data) {
        let lab_order = null;
        let lab_order_item = null;
        // 1. Direct match on lab_order_id
        if (data.lab_order_id && !data.lab_order_id.startsWith("BC") && !data.lab_order_id.startsWith("LOI")) {
            lab_order = await prisma_1.default.lab_order.findUnique({
                where: { lab_order_id: data.lab_order_id },
                include: {
                    patient_history: {
                        include: { patient_bio_data: true },
                    },
                    lab_order_item: {
                        include: { sample_collection: true, lab_result: true, lab_test_master: true },
                    },
                },
            });
        }
        // 2. Candidate item ID (either from lab_order_item_id or passed as lab_order_id)
        const candidateItemId = data.lab_order_item_id || (data.lab_order_id?.startsWith("LOI") ? data.lab_order_id : null);
        if (candidateItemId) {
            const item = await prisma_1.default.lab_order_item.findUnique({
                where: { lab_order_item_id: candidateItemId },
                include: {
                    sample_collection: true,
                    lab_result: true,
                    lab_test_master: true,
                    lab_order: {
                        include: {
                            patient_history: {
                                include: { patient_bio_data: true },
                            },
                            lab_order_item: {
                                include: { sample_collection: true, lab_result: true, lab_test_master: true },
                            },
                        },
                    },
                },
            });
            if (item) {
                lab_order_item = item;
                if (!lab_order && item.lab_order) {
                    lab_order = item.lab_order;
                }
            }
        }
        // 3. Candidate barcode (either from barcode or passed as lab_order_id)
        const candidateBarcode = data.barcode || (data.lab_order_id?.startsWith("BC") ? data.lab_order_id : null);
        if (candidateBarcode) {
            const sc = await prisma_1.default.sample_collection.findFirst({
                where: { barcode: candidateBarcode },
                include: {
                    lab_order_item: {
                        include: {
                            sample_collection: true,
                            lab_result: true,
                            lab_test_master: true,
                            lab_order: {
                                include: {
                                    patient_history: {
                                        include: { patient_bio_data: true },
                                    },
                                    lab_order_item: {
                                        include: { sample_collection: true, lab_result: true, lab_test_master: true },
                                    },
                                },
                            },
                        },
                    },
                },
            });
            if (sc?.lab_order_item) {
                if (!lab_order_item)
                    lab_order_item = sc.lab_order_item;
                if (!lab_order && sc.lab_order_item.lab_order)
                    lab_order = sc.lab_order_item.lab_order;
            }
        }
        // 4. If we have lab_order but need target lab_order_item
        if (lab_order && !lab_order_item && lab_order.lab_order_item?.length > 0) {
            if (candidateBarcode) {
                lab_order_item =
                    lab_order.lab_order_item.find((it) => it.sample_collection?.some((s) => s.barcode === candidateBarcode)) || lab_order.lab_order_item[0];
            }
            else {
                lab_order_item = lab_order.lab_order_item[0];
            }
        }
        // 5. Fallback findFirst in lab_order_item
        if (!lab_order && data.lab_order_id) {
            const item = await prisma_1.default.lab_order_item.findFirst({
                where: {
                    OR: [
                        { lab_order_item_id: data.lab_order_id },
                        { lab_order_id: data.lab_order_id },
                    ],
                },
                include: {
                    sample_collection: true,
                    lab_result: true,
                    lab_test_master: true,
                    lab_order: {
                        include: {
                            patient_history: {
                                include: { patient_bio_data: true },
                            },
                            lab_order_item: {
                                include: { sample_collection: true, lab_result: true, lab_test_master: true },
                            },
                        },
                    },
                },
            });
            if (item) {
                lab_order_item = item;
                lab_order = item.lab_order;
            }
        }
        return { lab_order, lab_order_item };
    }
    async create(data) {
        // 1. Resolve actual persisted lab order and lab order item
        const { lab_order, lab_order_item } = await this.resolveOrderAndItem(data);
        if (!lab_order) {
            throw new Error(`Cannot save report: No persisted laboratory order found for identifier "${data.lab_order_id || data.barcode || "unknown"}".`);
        }
        const actualLabOrderId = lab_order.lab_order_id;
        const actualOrderItemId = lab_order_item?.lab_order_item_id || data.lab_order_item_id;
        // 2. Verify patient relationship
        if (!lab_order.patient_history) {
            throw new Error(`Laboratory order "${actualLabOrderId}" is not linked to any patient clinical record.`);
        }
        // 3. Verify item belongs to order if specified
        if (actualOrderItemId && lab_order.lab_order_item?.length > 0) {
            const belongs = lab_order.lab_order_item.some((it) => it.lab_order_item_id === actualOrderItemId);
            if (!belongs) {
                throw new Error(`Laboratory order item "${actualOrderItemId}" does not belong to lab order "${actualLabOrderId}".`);
            }
        }
        // 4. Validate approved_by against employees safely
        let validApprovedBy = null;
        if (data.approved_by) {
            try {
                const emp = await prisma_1.default.employees.findFirst({
                    where: {
                        OR: [
                            { employee_id: data.approved_by },
                            { first_name: { contains: data.approved_by, mode: "insensitive" } },
                        ],
                    },
                });
                if (emp)
                    validApprovedBy = emp.employee_id;
            }
            catch {
                validApprovedBy = null;
            }
        }
        // 5. Validate branch_id safely
        let validBranchId = null;
        const requestedBranchId = data.branch_id ?? lab_order.branch_id ?? null;
        if (requestedBranchId) {
            try {
                const b = await prisma_1.default.branch.findUnique({
                    where: { branch_id: requestedBranchId },
                });
                if (b)
                    validBranchId = b.branch_id;
            }
            catch {
                validBranchId = null;
            }
        }
        // 6. Validate user_id safely
        let validUserId = null;
        if (data.user_id) {
            try {
                const u = await prisma_1.default.user_table.findUnique({
                    where: { user_id: data.user_id },
                });
                if (u)
                    validUserId = u.user_id;
            }
            catch {
                validUserId = null;
            }
        }
        // 7. Structure comment payload
        let commentPayload = toReportComment(data.report_comment);
        if (data.parameters || data.clinical_correlation || data.overall_decision) {
            commentPayload = {
                text: reportCommentText(commentPayload) || "Laboratory diagnostic report generated.",
                parameters: data.parameters || [],
                clinicalCorrelation: data.clinical_correlation || "",
                overallDecision: data.overall_decision || "APPROVED",
            };
        }
        // 8. Check if report already exists for actualLabOrderId or report_number
        let existingReport = null;
        if (data.report_number) {
            existingReport = await prisma_1.default.lab_report.findFirst({
                where: { report_number: data.report_number },
            });
        }
        if (!existingReport) {
            existingReport = await prisma_1.default.lab_report.findFirst({
                where: { lab_order_id: actualLabOrderId },
            });
        }
        const timestamp = Date.now();
        const finalReportId = existingReport ? existingReport.lab_report_id : `RPT${timestamp}`;
        const report_number = data.report_number ||
            existingReport?.report_number ||
            `RPT-${new Date().getFullYear()}-${timestamp.toString().slice(-6)}`;
        const approvedDatetime = data.approved_datetime
            ? new Date(data.approved_datetime)
            : new Date();
        // 9. Atomic database transaction to persist report and update all relationships
        const finalSavedReport = await prisma_1.default.$transaction(async (tx) => {
            let savedReport;
            if (existingReport) {
                savedReport = await tx.lab_report.update({
                    where: { lab_report_id: existingReport.lab_report_id },
                    data: {
                        report_number,
                        report_status: data.report_status || "Generated",
                        report_file: data.report_file ?? existingReport.report_file,
                        digital_signature: data.digital_signature ?? existingReport.digital_signature,
                        approved_by: validApprovedBy ?? existingReport.approved_by,
                        approved_datetime: approvedDatetime,
                        report_comment: commentPayload ? commentPayload : existingReport.report_comment,
                        updated_at: new Date(),
                    },
                    include: {
                        employees: true,
                        lab_order: {
                            include: {
                                patient_history: true,
                                employees: true,
                                lab_order_item: {
                                    include: {
                                        lab_test_master: true,
                                        sample_collection: true,
                                        lab_result: true,
                                    },
                                },
                            },
                        },
                    },
                });
            }
            else {
                savedReport = await tx.lab_report.create({
                    data: {
                        lab_report_id: finalReportId,
                        lab_order_id: actualLabOrderId,
                        report_number,
                        generated_datetime: data.generated_datetime
                            ? new Date(data.generated_datetime)
                            : new Date(),
                        approved_by: validApprovedBy,
                        approved_datetime: approvedDatetime,
                        report_status: data.report_status || "Generated",
                        report_file: data.report_file || null,
                        digital_signature: data.digital_signature || null,
                        report_comment: commentPayload,
                        delivered_to: data.delivered_to || null,
                        delivered_datetime: data.delivered_datetime
                            ? new Date(data.delivered_datetime)
                            : null,
                        branch_id: validBranchId,
                        user_id: validUserId,
                    },
                    include: {
                        employees: true,
                        lab_order: {
                            include: {
                                patient_history: true,
                                employees: true,
                                lab_order_item: {
                                    include: {
                                        lab_test_master: true,
                                        sample_collection: true,
                                        lab_result: true,
                                    },
                                },
                            },
                        },
                    },
                });
            }
            // Update all lab_order_item records under this order to Report Generated
            await tx.lab_order_item.updateMany({
                where: { lab_order_id: actualLabOrderId },
                data: {
                    item_status: "Report Generated",
                    updated_at: new Date(),
                },
            }).catch((err) => console.warn("Could not update lab_order_item in tx:", err));
            // Update parent lab_order status to Completed
            await tx.lab_order.update({
                where: { lab_order_id: actualLabOrderId },
                data: {
                    order_status: "Completed",
                    updated_at: new Date(),
                },
            }).catch((err) => console.warn("Could not update lab_order in tx:", err));
            // Link all lab_result rows for all items in this order to this report and mark Approved
            await tx.lab_result.updateMany({
                where: {
                    lab_order_item: {
                        lab_order_id: actualLabOrderId,
                    },
                },
                data: {
                    lab_report_id: savedReport.lab_report_id,
                    result_status: "Approved",
                    updated_at: new Date(),
                },
            }).catch(() => { });
            return savedReport;
        });
        if (finalSavedReport &&
            (finalSavedReport.approved_datetime ||
                finalSavedReport.report_status === "Approved" ||
                finalSavedReport.report_status === "Generated")) {
            const patientHistory = finalSavedReport.lab_order?.patient_history;
            const patientId = patientHistory?.patient_id;
            if (patientId) {
                const testNames = (finalSavedReport.lab_order?.lab_order_item || [])
                    .map((i) => i.lab_test_master?.test_name)
                    .filter(Boolean);
                const testsStr = testNames.length > 0 ? ` (${testNames.join(", ")})` : "";
                // Trigger in-app notifications
                patient_portal_service_1.PatientPortalService.createNotification(patientId, "Report Approved", `Your laboratory diagnostic report #${finalSavedReport.lab_report_id}${testsStr} has been approved.`, "REPORT_APPROVED", finalSavedReport.lab_report_id).catch(() => { });
                patient_portal_service_1.PatientPortalService.createNotification(patientId, "Report Available", `Your laboratory report #${finalSavedReport.lab_report_id} is now available in your Patient Portal for viewing and download.`, "REPORT_AVAILABLE", finalSavedReport.lab_report_id).catch(() => { });
                // Trigger email notification if patient email exists
                prisma_1.default.patient_bio_data
                    .findFirst({
                    where: { patient_id: patientId },
                    select: { patient_email: true, patient_first_name: true, patient_last_name: true },
                })
                    .then((p) => {
                    if (p?.patient_email) {
                        const patientName = [p.patient_first_name, p.patient_last_name].filter(Boolean).join(" ") || "Patient";
                        (0, mail_1.sendPatientReportAvailableEmail)(p.patient_email, patientName, finalSavedReport.lab_report_id, testNames).catch((e) => {
                            console.warn("[email] Could not send report email to patient:", e.message);
                        });
                    }
                })
                    .catch(() => { });
            }
        }
        return finalSavedReport;
    }
    async update(id, data) {
        const existing = await repository.findById(id);
        if (!existing) {
            throw new Error(`Lab report with id ${id} not found`);
        }
        let commentPayload = toReportComment(data.report_comment);
        if (data.parameters || data.clinical_correlation || data.overall_decision) {
            commentPayload = {
                text: reportCommentText(commentPayload) || reportCommentText(existing.report_comment),
                parameters: data.parameters || [],
                clinicalCorrelation: data.clinical_correlation || "",
                overallDecision: data.overall_decision || "APPROVED",
            };
        }
        const updateData = {
            updated_at: new Date(),
        };
        if (data.report_number !== undefined)
            updateData.report_number = data.report_number;
        if (data.generated_datetime !== undefined)
            updateData.generated_datetime = data.generated_datetime
                ? new Date(data.generated_datetime)
                : null;
        if (data.approved_datetime !== undefined)
            updateData.approved_datetime = data.approved_datetime
                ? new Date(data.approved_datetime)
                : null;
        if (data.report_status !== undefined)
            updateData.report_status = data.report_status;
        if (data.approved_by !== undefined) {
            let validApprovedBy = null;
            if (data.approved_by) {
                try {
                    const emp = await prisma_1.default.employees.findUnique({
                        where: { employee_id: data.approved_by },
                    });
                    if (emp)
                        validApprovedBy = emp.employee_id;
                }
                catch {
                    validApprovedBy = null;
                }
            }
            updateData.approved_by = validApprovedBy;
        }
        if (data.report_file !== undefined)
            updateData.report_file = data.report_file;
        if (data.digital_signature !== undefined)
            updateData.digital_signature = data.digital_signature;
        if (commentPayload !== undefined)
            updateData.report_comment = commentPayload;
        if (data.delivered_to !== undefined)
            updateData.delivered_to = data.delivered_to;
        if (data.delivered_datetime !== undefined)
            updateData.delivered_datetime = data.delivered_datetime
                ? new Date(data.delivered_datetime)
                : null;
        const updated = await repository.update(id, updateData);
        if (existing.lab_order_id) {
            await prisma_1.default.lab_order.update({
                where: { lab_order_id: existing.lab_order_id },
                data: { order_status: "Completed", updated_at: new Date() },
            }).catch(() => { });
            await prisma_1.default.lab_order_item.updateMany({
                where: { lab_order_id: existing.lab_order_id },
                data: { item_status: "Report Generated", updated_at: new Date() },
            }).catch(() => { });
            await prisma_1.default.lab_result.updateMany({
                where: {
                    lab_order_item: { lab_order_id: existing.lab_order_id },
                },
                data: { lab_report_id: existing.lab_report_id, result_status: "Approved", updated_at: new Date() },
            }).catch(() => { });
        }
        return updated;
    }
    async transfer(id, data) {
        const existing = await repository.findById(id);
        if (!existing) {
            throw new Error(`Lab report with id ${id} not found`);
        }
        return repository.transfer(id, {
            delivered_to: data.delivered_to,
            delivered_datetime: data.delivered_datetime
                ? new Date(data.delivered_datetime)
                : new Date(),
            report_status: data.report_status || "Delivered",
        });
    }
    async delete(id) {
        const existing = await repository.findById(id);
        if (!existing) {
            throw new Error(`Lab report with id ${id} not found`);
        }
        return repository.delete(id);
    }
}
exports.LabReportService = LabReportService;
