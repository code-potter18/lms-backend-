"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.phoneMatchVariants = void 0;
const phoneMatchVariants = (value) => {
    const digits = value.replace(/\D/g, "");
    if (!digits)
        return [];
    const internationalPrefix = value.trim().startsWith("+") || digits.startsWith("00");
    let nationalDigits = digits;
    if (digits.startsWith("0091") && digits.length === 14) {
        nationalDigits = digits.slice(4);
    }
    else if (digits.startsWith("91") && digits.length === 12) {
        nationalDigits = digits.slice(2);
    }
    else if (digits.startsWith("0") && digits.length === 11) {
        nationalDigits = digits.slice(1);
    }
    else if (digits.startsWith("00") && internationalPrefix) {
        nationalDigits = digits.slice(2);
    }
    if (nationalDigits.length === 10) {
        return [...new Set([
                nationalDigits,
                `91${nationalDigits}`,
                `0${nationalDigits}`,
                `0091${nationalDigits}`,
            ])];
    }
    if (internationalPrefix && !digits.startsWith("00")) {
        return [...new Set([digits, `00${digits}`])];
    }
    if (digits.startsWith("00")) {
        return [...new Set([digits, digits.slice(2)])];
    }
    return [digits];
};
exports.phoneMatchVariants = phoneMatchVariants;
