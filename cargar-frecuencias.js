const db = require("./src/config/database");

async function cargar() {
  try {

    await db.query(`
      INSERT INTO frecuencias
      (nombre,lunes,martes,miercoles,jueves,viernes,sabado)
      VALUES
      ('LUJU',true,false,false,true,false,false),
      ('MAVI',false,true,false,false,true,false),
      ('MISA',false,false,true,false,false,true),
      ('EJEC',false,false,false,false,false,false),
      ('LU',true,false,false,false,false,false),
      ('MA',false,true,false,false,false,false),
      ('MI',false,false,true,false,false,false),
      ('JU',false,false,false,true,false,false),
      ('VI',false,false,false,false,true,false),
      ('SA',false,false,false,false,false,true)
    `);

    console.log("Frecuencias Rebesa cargadas");

  } catch (error) {

    console.error(error.message);

  }

  process.exit();
}

cargar();