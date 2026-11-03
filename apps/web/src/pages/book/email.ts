export function isValidEmail(email: string) {
  return (
    /^(?!.*\.\.)[^\s@.][^\s@]*[^\s@.]@[^\s@.]+(?:\.[^\s@.]+)+$/u.test(email) ||
    /^(?!.*\.\.)[^\s@.]@[^\s@.]+(?:\.[^\s@.]+)+$/u.test(email)
  );
}
