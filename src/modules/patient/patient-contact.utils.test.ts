import assert from "node:assert/strict";
import test from "node:test";
import { phoneMatchVariants } from "./patient-contact.utils";

test("matches Indian mobile numbers across common country-code and formatting forms", () => {
    const expected = phoneMatchVariants("9876543210").sort();

    assert.deepEqual(phoneMatchVariants("+91 98765-43210").sort(), expected);
    assert.deepEqual(phoneMatchVariants("0091 (98765) 43210").sort(), expected);
    assert.deepEqual(phoneMatchVariants("09876543210").sort(), expected);
});

test("does not equate different mobile numbers", () => {
    const first = phoneMatchVariants("+91 9876543210");
    const second = phoneMatchVariants("+91 9876543211");

    assert.equal(first.some((number) => second.includes(number)), false);
});

test("matches an explicit international prefix in plus and 00 notation", () => {
    const withPlus = phoneMatchVariants("+1 212-555-0123").sort();
    const with00 = phoneMatchVariants("001 212-555-0123").sort();

    assert.deepEqual(withPlus, with00);
});
