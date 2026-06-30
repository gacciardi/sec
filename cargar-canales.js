const db = require("./src/config/database");

async function cargar() {
  try {
    await db.query(`
      INSERT INTO canales (nombre, permanencia_minima)
      VALUES
      ('KIOSCOS', 3),
      ('ALMACENES', 5),
      ('SELF SERVICE', 8),
      ('OPERADORES Y OTROS', 10),
      ('DEPOSITO', 5),
      ('BCR SOFISTICADO', 8),
      ('EMERGENTES', 5)
      ON CONFLICT (nombre) DO NOTHING
    `);

    console.log("Canales Rebesa cargados");
  } catch (error) {
    console.error(error.message);
  }

  process.exit();
}

cargar();