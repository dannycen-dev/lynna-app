import { describe, expect, it } from "vitest";
import { parseLotsCsv } from "../src/catalog/lots-import";
import { normalizeHeader, parseCsv } from "../src/lib/csv";

describe("parseCsv", () => {
  it("maneja comillas, comillas escapadas, saltos de línea, CRLF y BOM", () => {
    const csv = '﻿a,b,c\r\n1,"dos, con coma","tres ""con"" comillas"\r\n"multi\nlínea",x,\r\n\r\n';
    expect(parseCsv(csv)).toEqual([
      ["a", "b", "c"],
      ["1", "dos, con coma", 'tres "con" comillas'],
      ["multi\nlínea", "x", ""],
    ]);
  });

  it("detecta punto y coma como separador (Excel en español)", () => {
    expect(parseCsv("manzana;lote\nA;1")).toEqual([["manzana", "lote"], ["A", "1"]]);
  });

  it("normaliza encabezados", () => {
    expect(normalizeHeader(" Precio por m² ")).toBe("precio_por_m2");
    expect(normalizeHeader("Características")).toBe("caracteristicas");
  });
});

describe("parseLotsCsv", () => {
  it("convierte precios con formato y calcula el total si falta", () => {
    const { rows, errors } = parseLotsCsv(
      'Manzana,Lote,Superficie m2,Precio por m²,Estado\nA,1,250,"$3,200.50",Disponible\nA,2,"1,000",3000,apartado',
    );
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ block: "A", number: "1", area: 250, pricePerM2: 320_050, totalPrice: 80_012_500, status: "available", line: 2 });
    expect(rows[1]).toMatchObject({ area: 1000, totalPrice: 300_000_000, status: "reserved" });
  });

  it("reporta errores por renglón y columnas faltantes", () => {
    expect(parseLotsCsv("manzana,lote\nA,1").errors.map((e) => e.field)).toEqual(["superficie_m2", "precio_m2"]);

    const { errors } = parseLotsCsv("manzana,lote,superficie_m2,precio_m2,estado\nA,1,-5,abc,regalado\nA,2,100,10\nA,2,100,10");
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ line: 2, field: "superficie_m2" }),
        expect.objectContaining({ line: 2, field: "precio_m2" }),
        expect.objectContaining({ line: 2, field: "estado" }),
        expect.objectContaining({ line: 4, message: expect.stringContaining("Lote repetido") }),
      ]),
    );
  });
});
