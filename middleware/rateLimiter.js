const rateLimit = require('express-rate-limit');

/**
 * OTP send: 5 requests per 15 minutes per IP
 * Prevents SMTP bill abuse and enumeration attacks
 */
const otpSendLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many OTP requests. Please wait 15 minutes.' },
});

/**
 * OTP verify: 10 requests per 15 minutes per IP
 * Prevents brute-force of 6-digit codes
 */
const otpVerifyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many verification attempts. Please wait 15 minutes.' },
});

/**
 * General auth limiter: 20 requests per 15 minutes
 */
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many auth requests. Please try again later.' },
});

/**
 * B2B registration: 10 requests per hour per IP
 */
const b2bRegisterLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many registration attempts.' },
});

module.exports = { otpSendLimiter, otpVerifyLimiter, authLimiter, b2bRegisterLimiter };
