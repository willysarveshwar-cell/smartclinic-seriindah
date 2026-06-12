const bcrypt = require("bcryptjs");

function isBcryptHash(value = "") {
  return /^\$2[aby]\$\d{2}\$.{53}$/.test(value);
}

async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

async function comparePassword(plainPassword, storedPassword) {
  if (!storedPassword) return false;

  if (isBcryptHash(storedPassword)) {
    return bcrypt.compare(plainPassword, storedPassword);
  }

  // Backward compatibility with older plain-text records.
  return plainPassword === storedPassword;
}

module.exports = {
  isBcryptHash,
  hashPassword,
  comparePassword
};
