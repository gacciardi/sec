const { v2: cloudinary } = require("cloudinary");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
   signature_algorithm: "sha256"
  secure: true
});

console.log("CLOUDINARY CONFIG:");
console.log(cloudinary.config());

module.exports = cloudinary;