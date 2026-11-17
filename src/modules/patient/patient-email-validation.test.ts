import assert from "node:assert/strict";
import test from "node:test";
import { Request } from "express";
import { validationResult } from "express-validator";
import { createPatientValidation } from "./patient.validation";

const validateCreatePatient = async (email?: string, labWalkIn = true) => {
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
    } as unknown as Request;

    await Promise.all(createPatientValidation.map((validator) => validator.run(request)));
    return validationResult(request).array();
};

test("patient creation requires a valid email address", async (t) => {
    await t.test("rejects a missing email", async () => {
        const errors = await validateCreatePatient();
        assert.ok(errors.some((error) => error.msg === "Email is required for lab walk-in registration"));
    });

    await t.test("rejects an invalid email", async () => {
        const errors = await validateCreatePatient("not-an-email");
        assert.ok(errors.some((error) => error.msg === "Valid email is required"));
    });

    await t.test("accepts a valid email", async () => {
        const errors = await validateCreatePatient("patient@example.test");
        assert.deepEqual(errors, []);
    });

    await t.test("preserves other patient registration workflows without an email", async () => {
        const errors = await validateCreatePatient(undefined, false);
        assert.deepEqual(errors, []);
    });
});
