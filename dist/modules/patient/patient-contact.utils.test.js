"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const patient_contact_utils_1 = require("./patient-contact.utils");
(0, node_test_1.default)("matches Indian mobile numbers across common country-code and formatting forms", () => {
    const expected = (0, patient_contact_utils_1.phoneMatchVariants)("9876543210").sort();
    strict_1.default.deepEqual((0, patient_contact_utils_1.phoneMatchVariants)("+91 98765-43210").sort(), expected);
    strict_1.default.deepEqual((0, patient_contact_utils_1.phoneMatchVariants)("0091 (98765) 43210").sort(), expected);
    strict_1.default.deepEqual((0, patient_contact_utils_1.phoneMatchVariants)("09876543210").sort(), expected);
});
(0, node_test_1.default)("does not equate different mobile numbers", () => {
    const first = (0, patient_contact_utils_1.phoneMatchVariants)("+91 9876543210");
    const second = (0, patient_contact_utils_1.phoneMatchVariants)("+91 9876543211");
    strict_1.default.equal(first.some((number) => second.includes(number)), false);
});
(0, node_test_1.default)("matches an explicit international prefix in plus and 00 notation", () => {
    const withPlus = (0, patient_contact_utils_1.phoneMatchVariants)("+1 212-555-0123").sort();
    const with00 = (0, patient_contact_utils_1.phoneMatchVariants)("001 212-555-0123").sort();
    strict_1.default.deepEqual(withPlus, with00);
});
