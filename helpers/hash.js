const bcrypt = require('bcrypt');



const hashPassword = async (password) => {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
};

const comparePassword = async (plainPassword, hashedPassword) => {
  return bcrypt.compare(plainPassword, hashedPassword);
};

const sendPasswordEmail = async (password) => {
  const hashedPassword = await hashPassword(password);
  return hashedPassword;
};

module.exports = { hashPassword, comparePassword, sendPasswordEmail };
