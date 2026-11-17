"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const express_validator_1 = require("express-validator");
const patient_validation_1 = require("./patient.validation");
const validateCreatePatient = async (email, labWalkIn = true) => {
    const request = {
        body: {
            username: "synthetic_walkin",
            password: "synthetic-password",
            first_name: "Synthetic",
            mobile: "+1 212 555 0123",
            ...(email === undefined ? {} : { email }),
            branch_id: "synthetic-branch",
            created_by: "synthetic-user",
            ...(labWalkIn ? { registration_source: "LAB_WALK_IN" } : {}),
        },
        params: {},
        query: {},
        headers: {},
        cookies: {},
    };
    await Promise.all(patient_validation_1.createPatientValidation.map((validator) => validator.run(request)));
    return (0, express_validator_1.validationResult)(request).array();
};
(0, node_test_1.default)("patient creation requires a valid email address", async (t) => {
    await t.test("rejects a missing email", async () => {
        const errors = await validateCreatePatient();
        strict_1.default.ok(errors.some((error) => error.msg === "Email is required for lab walk-in registration"));
    });
    await t.test("rejects an invalid email", async () => {
        const errors = await validateCreatePatient("not-an-email");
        strict_1.default.ok(errors.some((error) => error.msg === "Valid email is required"));
    });
    await t.test("accepts a valid email", async () => {
        const errors = await validateCreatePatient("patient@example.test");
        strict_1.default.deepEqual(errors, []);
    });
    await t.test("preserves other patient registration workflows without an email", async () => {
        const errors = await validateCreatePatient(undefined, false);
        strict_1.default.deepEqual(errors, []);
    });
});
