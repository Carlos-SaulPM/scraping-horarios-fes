import { chromium } from "playwright";
import { writeFile } from "fs/promises";

const URL = "https://www.aragon.unam.mx/horarios/horarios/horarios/";

let formatearHorario = (texto) => {
  if (!texto) return "";
  const limpio = texto.trim().replace(/\s+/g, "");
  const partes = limpio.match(/\d{2}:\d{2}/g);
  if (!partes || partes.length < 2) return limpio;
  return partes.join("-");
};

let obtenerHorarios = async () => {
  console.log("🌐 Abriendo página...");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto(URL, { waitUntil: "networkidle" });
  console.log("📥 Esperando los selects...");
  await page.waitForSelector("#sem");
  await page.waitForSelector("#carr");

  console.log("📌 Seleccionando valores...");
  await page.selectOption("#sem", "33");
  await page.selectOption("#carr", "12");
  await page.fill("#grupo", "");

  console.log("📨 Enviando formulario...");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle" }),
    page.click('input[type="submit"]'),
  ]);

  console.log("📊 Página de grupos cargada");
  await page.waitForSelector("#gpos");

  const grupos = await page.$$eval("#gpos option", (options) =>
    options.filter((opt) => opt.value !== "x").map((opt) => opt.value)
  );

  const resultados = {};

  for (const grupo of grupos) {
    await page.selectOption("#gpos", grupo);
    await page.waitForFunction(() => {
      const tabla = document.querySelector("#tabla");
      return tabla && tabla.innerHTML.includes("<table");
    });
    await page.waitForTimeout(300); // Por si tarda en renderizar

    const datos = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("#tabla table tr"));
      if (rows.length <= 1) return [];

      return rows.slice(1).map((tr) => {
        const tds = tr.querySelectorAll("td");
        return {
          profesor: tds[0]?.textContent.trim() || "",
          clave: tds[1]?.textContent.trim() || "",
          materia: tds[2]?.textContent.trim() || "",
          grupo: tds[3]?.textContent.trim() || "",
          tipo: tds[4]?.textContent.trim() || "",
          horario: {
            LU: tds[5]?.textContent || "",
            MA: tds[6]?.textContent || "",
            MI: tds[7]?.textContent || "",
            JU: tds[8]?.textContent || "",
            VI: tds[9]?.textContent || "",
            SA: tds[10]?.textContent || "",
          },
          salon: tds[11]?.textContent.trim() || "",
          cupo: tds[12]?.textContent.trim() || "",
        };
      });
    });

    // 🔧 Aplicamos formateo de horarios aquí (ya en Node.js)
    resultados[grupo] = datos.map((materia) => ({
      ...materia,
      horario: {
        LU: formatearHorario(materia.horario.LU),
        MA: formatearHorario(materia.horario.MA),
        MI: formatearHorario(materia.horario.MI),
        JU: formatearHorario(materia.horario.JU),
        VI: formatearHorario(materia.horario.VI),
        SA: formatearHorario(materia.horario.SA),
      },
    }));
  }

  await writeFile(
    "horarios.json",
    JSON.stringify(resultados, null, 2),
    "utf-8"
  );
  console.log("✅ Datos guardados en horarios.json");

  const primerGrupo = Object.keys(resultados)[0];
  console.log(`📋 Primer grupo (${primerGrupo}):`);
  console.log(resultados[primerGrupo]);

  await browser.close();
};

obtenerHorarios();
