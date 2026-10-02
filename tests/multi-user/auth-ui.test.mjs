import assert from "node:assert/strict";
import test from "node:test";
import { PHONE_COUNTRIES, formatPhoneInput, maskPhone, registrationStep, toE164Phone, translateAuthError, validatePassword, validatePhone } from "../../src/auth-ui.js";

test("China phone input stays empty initially and formats as 3-4-4", () => {
  assert.equal(formatPhoneInput("", "CN"), "");
  assert.equal(formatPhoneInput("13673387723", "CN"), "136 7338 7723");
  assert.equal(toE164Phone(PHONE_COUNTRIES[0], "136 7338 7723"), "+8613673387723");
});

test("phone validation keeps China intentionally lightweight", () => {
  assert.equal(validatePhone(PHONE_COUNTRIES[0], "13673387723"), "");
  assert.match(validatePhone(PHONE_COUNTRIES[0], "23673387723"), /11 位/);
  assert.equal(validatePhone(PHONE_COUNTRIES[1], "123"), "");
});

test("OTP display masks the phone and auth errors are translated", () => {
  assert.equal(maskPhone(PHONE_COUNTRIES[0], "13673387723"), "+86 136****7723");
  assert.equal(translateAuthError("Invalid login credentials"), "手机号或密码不正确。");
  assert.equal(translateAuthError("Unable to get SMS provider"), "短信服务暂时不可用，请稍后再试。");
});

test("registration password checks are native-auth compatible", () => {
  assert.match(validatePassword("12345"), /至少需要 6 位/);
  assert.match(validatePassword("123456", "123457"), /不一致/);
  assert.equal(validatePassword("123456", "123456"), "");
});

test("registration stays in OTP and then SET_PASSWORD before app access", () => {
  assert.equal(registrationStep(false, false), "phone");
  assert.equal(registrationStep(true, false), "otp");
  assert.equal(registrationStep(true, true), "set-password");
});
