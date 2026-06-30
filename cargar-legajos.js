const db = require("./src/config/database");

async function cargar() {
  try {
    await db.query("UPDATE usuarios SET legajo='1001' WHERE email='vendedor1@sec.com'");
    await db.query("UPDATE usuarios SET legajo='1002' WHERE email='vendedor2@sec.com'");

    console.log("Legajos cargados");
  } catch (error) {
    console.error(error.message);
  }

  process.exit();
}

cargar();