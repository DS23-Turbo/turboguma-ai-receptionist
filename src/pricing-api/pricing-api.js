const PRICE_CACHE_KEY = "TURBOGUMA_PRICE_TABLE_V1";
const PRICE_CACHE_TTL_SECONDS = 60;

function doPost(e) {
  try {
    const apiKey = PropertiesService
      .getScriptProperties()
      .getProperty("PRICE_API_KEY");

    const receivedKey =
      e && e.parameter
        ? String(e.parameter.key || "")
        : "";

    if (!apiKey || !receivedKey || receivedKey !== apiKey) {
      return jsonResponse({
        success: false,
        error: "Unauthorized"
      });
    }

    let body = {};

    try {
      body = JSON.parse(
        e && e.postData && e.postData.contents
          ? e.postData.contents
          : "{}"
      );
    } catch (error) {
      return jsonResponse({
        success: false,
        error: "Nieprawidłowy JSON"
      });
    }

    const data = body.args || body;

    const service = cleanString(data.service);
    const rim = cleanString(data.rim);
    const size = cleanString(data.size);

    const suv =
      data.suv === true ||
      String(data.suv).toLowerCase() === "true";

    const runflat =
      data.runflat === true ||
      String(data.runflat).toLowerCase() === "true";

    if (!service || !rim || !size) {
      return jsonResponse({
        success: false,
        error: "Brakuje wymaganych parametrów"
      });
    }

    const priceData = getPriceData();

    if (!priceData) {
      return jsonResponse({
        success: false,
        error: "Nie udało się odczytać cennika"
      });
    }

    const key =
      service + "|" + rim + "|" + size;

    const basePrice =
      priceData.prices[key];

    if (
      basePrice === undefined ||
      basePrice === null ||
      Number.isNaN(Number(basePrice))
    ) {
      return jsonResponse({
        success: false,
        error: "Nie znaleziono ceny"
      });
    }

    let finalPrice = Number(basePrice);

    if (suv) {
      finalPrice += Number(
        priceData.extras.SUV || 0
      );
    }

    if (runflat) {
      finalPrice += Number(
        priceData.extras.RunFlat || 0
      );
    }

    return jsonResponse({
      success: true,
      service: service,
      rim: rim,
      size: size,
      suv: suv,
      runflat: runflat,
      base_price: Number(basePrice),
      final_price: finalPrice,
      currency: "PLN"
    });

  } catch (error) {
    return jsonResponse({
      success: false,
      error: "Internal server error"
    });
  }
}


function getPriceData() {
  const cache =
    CacheService.getScriptCache();

  const cached =
    cache.get(PRICE_CACHE_KEY);

  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (error) {
      // jeśli cache jest uszkodzony,
      // po prostu odczytaj arkusz ponownie
    }
  }

  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheetByName("Cennik");

  if (!sheet) {
    return null;
  }

  const rows =
    sheet.getDataRange().getValues();

  const prices = {};
  const extras = {};

  // Główna tabela cen:
  // kolumna B = Usługa
  // kolumna C = Felga
  // kolumna D = Rozmiar
  // kolumna G = Cena PLN
  for (let i = 1; i < rows.length; i++) {
    const service =
      cleanString(rows[i][1]);

    const rim =
      cleanString(rows[i][2]);

    const size =
      cleanString(rows[i][3]);

    const price =
      Number(rows[i][6]);

    if (
      service &&
      rim &&
      size &&
      Number.isFinite(price)
    ) {
      const key =
        service + "|" + rim + "|" + size;

      prices[key] = price;
    }
  }

  // Dodatki:
  // kolumna B = nazwa dodatku
  // kolumna C = cena
  for (let i = 12; i < rows.length; i++) {
    const extraName =
      cleanString(rows[i][1]);

    const extraPrice =
      Number(rows[i][2]);

    if (
      extraName &&
      Number.isFinite(extraPrice)
    ) {
      extras[extraName] = extraPrice;
    }
  }

  const result = {
    prices,
    extras
  };

  cache.put(
    PRICE_CACHE_KEY,
    JSON.stringify(result),
    PRICE_CACHE_TTL_SECONDS
  );

  return result;
}


function cleanString(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  return String(value).trim();
}


function jsonResponse(data) {
  return ContentService
    .createTextOutput(
      JSON.stringify(data)
    )
    .setMimeType(
      ContentService.MimeType.JSON
    );
}
