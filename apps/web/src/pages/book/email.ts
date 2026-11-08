const multiCharacterLocalPart = /^(?!.*\.\.)[^\s@.][^\s@]*[^\s@.]@[^\s@.]+(?:\.[^\s@.]+)+$/u;
const singleCharacterLocalPart = /^(?!.*\.\.)[^\s@.]@[^\s@.]+(?:\.[^\s@.]+)+$/u;

export function isValidEmail(email: string) {
  return multiCharacterLocalPart.test(email) || singleCharacterLocalPart.test(email);
}
