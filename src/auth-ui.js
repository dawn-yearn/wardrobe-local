export const PHONE_COUNTRIES = [
  { id: "CN", flag: "🇨🇳", label: "中国", dialCode: "+86" },
  { id: "US", flag: "🇺🇸", label: "美国", dialCode: "+1" },
  { id: "JP", flag: "🇯🇵", label: "日本", dialCode: "+81" },
  { id: "KR", flag: "🇰🇷", label: "韩国", dialCode: "+82" },
];

export function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

export function formatPhoneInput(value, countryId) {
  const digits = digitsOnly(value);
  if (countryId !== "CN") return digits;
  return [digits.slice(0, 3), digits.slice(3, 7), digits.slice(7, 11)].filter(Boolean).join(" ");
}

export function toE164Phone(country, value) {
  return `${country.dialCode}${digitsOnly(value)}`;
}

export function validatePhone(country, value) {
  const digits = digitsOnly(value);
  if (!digits) return "请输入手机号。";
  if (country.id === "CN" && !/^1\d{10}$/.test(digits)) return "请输入 11 位手机号，第一位为 1。";
  return "";
}

export function maskPhone(country, value) {
  const digits = digitsOnly(value);
  if (!digits) return `${country.dialCode} ****`;
  const prefix = digits.length > 4 ? `${digits.slice(0, 3)}****` : "****";
  return `${country.dialCode} ${prefix}${digits.slice(-4)}`;
}

export function translateAuthError(message = "") {
  const value = String(message);
  if (/invalid login credentials/i.test(value)) return "手机号或密码不正确。";
  if (/user already registered|already exists/i.test(value)) return "该手机号已注册，请直接登录。";
  if (/password should be at least|password.*(characters|length)/i.test(value)) return "密码长度不符合当前安全要求。";
  if (/token has expired|invalid.*token|otp.*expired|invalid.*otp/i.test(value)) return "验证码已过期或不正确。";
  if (/unable to get sms provider/i.test(value)) return "短信服务暂时不可用，请稍后再试。";
  if (/phone.*not.*enabled|phone provider/i.test(value)) return "手机号登录服务尚未启用，请稍后再试。";
  return value || "请求失败，请稍后再试。";
}

export function validatePassword(password, confirmation = null) {
  if (!password) return "请输入密码。";
  if (password.length < 6) return "密码至少需要 6 位。";
  if (confirmation !== null && password !== confirmation) return "两次输入的密码不一致。";
  return "";
}

export function registrationStep(sent, verified) {
  if (!sent) return "phone";
  if (!verified) return "otp";
  return "set-password";
}
