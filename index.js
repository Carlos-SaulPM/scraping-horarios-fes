import { writeFile } from "fs/promises";

const BASE =
  "https://www.aragon.unam.mx/horarios/horarios/index_archivos/php/queysA.php";

const SEM = process.env.SEM || "35";
const CARR = process.env.CARR || "12";
const HORARIOS_OUT = process.env.HORARIOS_OUT || "horarios.json";
const EXTERNAS_OUT = process.env.EXTERNAS_OUT || "materias_externas_coincidentes.json";
const CONCURRENCIA = parseInt(process.env.CONCURRENCIA || "8", 10);
const INTENTOS = 3;

const ENTIDADES = {
  "&Aacute;": "Á",
  "&Eacute;": "É",
  "&Iacute;": "Í",
  "&Oacute;": "Ó",
  "&Uacute;": "Ú",
  "&Ntilde;": "Ñ",
  "&aacute;": "á",
  "&eacute;": "é",
  "&iacute;": "í",
  "&oacute;": "ó",
  "&uacute;": "ú",
  "&ntilde;": "ñ",
  "&uuml;": "ü",
  "&Uuml;": "Ü",
  "&amp;": "&",
  "&quot;": '"',
  "&apos;": "'",
  "&lt;": "<",
  "&gt;": ">",
};

const decodificar = (texto) =>
  texto.replace(/&[A-Za-z]+;/g, (entidad) => ENTIDADES[entidad] ?? entidad);

const getJSON = async (params) => {
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE}?${qs}`;
  for (let intento = 1; intento <= INTENTOS; intento++) {
    try {
      const respuesta = await fetch(url);
      if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);
      return await respuesta.json();
    } catch (error) {
      if (intento === INTENTOS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * intento));
    }
  }
};

const procesarConLimite = async (items, limite, fn) => {
  const salidas = new Array(items.length);
  let siguiente = 0;
  const trabajador = async () => {
    while (siguiente < items.length) {
      const indice = siguiente++;
      salidas[indice] = await fn(items[indice], indice);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limite, items.length) }, trabajador),
  );
  return salidas;
};

const formatearHorario = (texto) => {
  if (!texto) return "";
  const limpio = texto.trim().replace(/\s+/g, "");
  const partes = limpio.match(/\d{2}:\d{2}/g);
  if (!partes || partes.length < 2) return limpio;
  return partes.join("-");
};

const TIPOS = { P: "PRESENCIAL", S: "SEMIPRESENCIAL", A: "A DISTANCIA", X: "" };

const mapearClase = (cruda) => ({
  profesor: (cruda.nomb_prof || "").trim(),
  clave: (cruda.clv_materia || "").trim(),
  materia: (cruda.nomb_cmateria || "").trim(),
  grupo: (cruda.grupo || "").trim(),
  tipo: TIPOS[cruda.tipoclase] ?? "",
  horario: {
    LU: formatearHorario(cruda.LU),
    MA: formatearHorario(cruda.MA),
    MI: formatearHorario(cruda.MI),
    JU: formatearHorario(cruda.JU),
    VI: formatearHorario(cruda.VI),
    SA: formatearHorario(cruda.SA),
  },
  salon: (cruda.clv_salon || "") === "SINDEF" ? "-" : (cruda.clv_salon || "").trim(),
  cupo: (cruda.cupo || "").trim(),
});

const gruposDeCarrera = async (idCarrera) => {
  const grupos = (await getJSON({ tipo: 4, sem: SEM, carr: idCarrera })).map(
    (g) => g.grupo,
  );
  return grupos;
};

const scrapearGrupos = async (idCarrera, grupos, filtro) => {
  const listas = await procesarConLimite(grupos, CONCURRENCIA, async (grupo) => {
    const crudas = await getJSON({ tipo: 2, sem: SEM, carr: idCarrera, grupo });
    let clases = crudas.map(mapearClase);
    if (filtro) clases = clases.filter(filtro);
    return { grupo, clases };
  });
  const resultado = {};
  for (const { grupo, clases } of listas) {
    if (clases.length) resultado[grupo] = clases;
  }
  return resultado;
};

const main = async () => {
  console.log("🌐 Obteniendo carreras...");
  const carreras = (await getJSON({ tipo: 1 })).map((c) => ({
    id: c.id_area,
    nombre: decodificar(c.nombre).trim(),
  }));

  const principal = carreras.find((c) => c.id === CARR);
  if (!principal) throw new Error(`No se encontró la carrera ${CARR}`);
  console.log(`📌 Carrera principal: ${principal.nombre} (${principal.id})`);

  console.log(`🔎 Scrapeando horarios de ${principal.nombre} (sem ${SEM})...`);
  const horarios = await scrapearGrupos(principal.id, await gruposDeCarrera(principal.id));

  const todas = Object.values(horarios).flat();
  console.log(
    `  ${Object.keys(horarios).length} grupos, ${todas.length} materias, ${new Set(todas.map((c) => c.clave)).size} claves únicas`,
  );

  await writeFile(HORARIOS_OUT, JSON.stringify(horarios, null, 2), "utf-8");
  console.log(`✅ Escrito ${HORARIOS_OUT}`);

  const nombresPorClave = new Map();
  for (const { clave, materia } of todas) {
    const nombres = nombresPorClave.get(clave) ?? new Set();
    nombres.add(materia);
    nombresPorClave.set(clave, nombres);
  }

  console.log("🌐 Scrapeando materias externas coincidentes...");
  const externas = {};
  for (const carrera of carreras) {
    if (carrera.id === CARR) continue;
    const grupos = await gruposDeCarrera(carrera.id);
    if (!grupos.length) {
      console.log(`  ⏭  ${carrera.nombre}: sin grupos`);
      continue;
    }
    const coincidentes = await scrapearGrupos(carrera.id, grupos, (c) =>
      nombresPorClave.get(c.clave)?.has(c.materia),
    );
    if (Object.keys(coincidentes).length) {
      externas[carrera.nombre] = coincidentes;
      console.log(
        `  ✅ ${carrera.nombre}: ${Object.keys(coincidentes).length} grupos, ${Object.values(coincidentes).flat().length} materias coincidentes`,
      );
    } else {
      console.log(`  ⏭  ${carrera.nombre}: sin coincidencias`);
    }
  }

  await writeFile(EXTERNAS_OUT, JSON.stringify(externas, null, 2), "utf-8");
  console.log(`✅ Escrito ${EXTERNAS_OUT}`);
  console.log("🏁 Terminado");
};

main().catch((error) => {
  console.error("❌ Error:", error);
  process.exit(1);
});
