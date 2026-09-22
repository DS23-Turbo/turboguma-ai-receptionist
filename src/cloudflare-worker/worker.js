import crypto from "node:crypto";

const KV_TTL_90_DAYS = 7776000;
const RETRY_TTL_SECONDS = 259200;
const FAILED_TTL_SECONDS = 604800;
const RETRY_DELAY_MS = 60 * 60 * 1000;
const MAX_SMS_ATTEMPTS = 3;

const BOOKING_DEDUP_TTL_SECONDS = 600;
const BOOKING_PROCESSING_TTL_SECONDS = 90;
const BOOKING_PROCESSING_POLL_MS = 750;
const BOOKING_PROCESSING_MAX_POLLS = 4;

const CAL_EVENT_TYPE_ID = 6668943;
const CAL_API_VERSION = "2024-08-13";
const CAL_RESCHEDULE_API_VERSION = "2026-02-25";
const DEFAULT_TIMEZONE = "Europe/Warsaw";

// =====================================
// HELPERY
// =====================================

function phpUrlEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/%20/g, "+")
    .replace(/[!'()*~]/g, (c) =>
      "%" + c.charCodeAt(0).toString(16).toUpperCase()
    );
}

function buildParams(params) {
  return Object.keys(params)
    .sort()
    .map(
      (key) =>
        `${phpUrlEncode(key)}=${phpUrlEncode(params[key])}`
    )
    .join("&");
}

function formatAppointment(startTime) {
  const date = new Date(startTime);

  const dateFormatter = new Intl.DateTimeFormat(
    "pl-PL",
    {
      timeZone: DEFAULT_TIMEZONE,
      day: "2-digit",
      month: "2-digit",
    }
  );

  const timeFormatter = new Intl.DateTimeFormat(
    "pl-PL",
    {
      timeZone: DEFAULT_TIMEZONE,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }
  );

  return {
    date: dateFormatter.format(date),
    time: timeFormatter.format(date),
  };
}

function formatBookingForRetell(startTime) {
  const date = new Date(startTime);

  const dateFormatter =
    new Intl.DateTimeFormat(
      "pl-PL",
      {
        timeZone: DEFAULT_TIMEZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }
    );

  const timeFormatter =
    new Intl.DateTimeFormat(
      "pl-PL",
      {
        timeZone: DEFAULT_TIMEZONE,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }
    );

  return {
    date:
      dateFormatter.format(date),

    time:
      timeFormatter.format(date),
  };
}

function normalizePhone(phone) {
  return String(
    phone || ""
  ).replace(/^\+/, "");
}

function normalizePolishPhone(value) {
  if (!value) {
    return null;
  }

  const phone =
    String(value)
      .replace(/\s+/g, "")
      .replace(/[()-]/g, "");

  if (
    /^\+48\d{9}$/.test(phone)
  ) {
    return phone;
  }

  if (
    /^48\d{9}$/.test(phone)
  ) {
    return "+" + phone;
  }

  if (
    /^\d{9}$/.test(phone)
  ) {
    return "+48" + phone;
  }

  return null;
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

function isSmsTestMode(env) {
  return String(
    env?.SMS_TEST_MODE || ""
  )
    .trim()
    .toLowerCase() === "true";
}

function extractPrice(
  additionalNotes
) {
  if (!additionalNotes) {
    return null;
  }

  const match =
    String(
      additionalNotes
    ).match(
      /cena\s*:\s*(\d+(?:[.,]\d+)?)\s*(?:zł|zl)/i
    );

  if (!match) {
    return null;
  }

  return match[1].replace(
    ",",
    "."
  );
}

function buildAdditionalNotes(
  notes,
  finalPrice
) {
  const cleaned =
    cleanString(notes);

  const hasPrice =
    /cena\s*:\s*\d+(?:[.,]\d+)?\s*(?:zł|zl)/i.test(
      cleaned
    );

  if (hasPrice) {
    return cleaned;
  }

  return `${cleaned}, cena: ${finalPrice} zł`;
}

function getRetryKey(
  type,
  bookingId
) {
  return `sms_retry:${type}:${bookingId}`;
}

function getFailedKey(
  type,
  bookingId
) {
  return `sms_failed:${type}:${bookingId}`;
}

function smsDeliveryRecord(
  smsResult,
  extra = {}
) {
  const skipped =
    Boolean(
      smsResult?.skipped
    );

  return {
    status:
      skipped
        ? "skipped_test"
        : "sent",

    sentAt:
      skipped
        ? null
        : new Date()
            .toISOString(),

    skippedAt:
      skipped
        ? new Date()
            .toISOString()
        : null,

    testMode:
      skipped,

    ...extra,
  };
}

function jsonResponse(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(data),
    {
      status,

      headers: {
        "Content-Type":
          "application/json",
      },
    }
  );
}

function sleep(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(resolve, ms)
  );
}

function isAuthorizedRetell(
  env,
  url
) {
  const receivedKey =
    cleanString(
      url.searchParams.get(
        "key"
      )
    );

  return Boolean(
    env.RETELL_BOOKING_KEY &&
    receivedKey &&
    receivedKey ===
      env.RETELL_BOOKING_KEY
  );
}

// =====================================
// CZAS WARSZAWA -> UTC
// =====================================

function warsawLocalIsoToUtc(
  value
) {
  const match =
    String(value).match(
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
    );

  if (!match) {
    return null;
  }

  const year =
    Number(match[1]);

  const month =
    Number(match[2]);

  const day =
    Number(match[3]);

  const hour =
    Number(match[4]);

  const minute =
    Number(match[5]);

  const second =
    Number(
      match[6] || 0
    );

  const localAsUtc =
    Date.UTC(
      year,
      month - 1,
      day,
      hour,
      minute,
      second
    );

  let guess =
    new Date(localAsUtc);

  for (
    let i = 0;
    i < 2;
    i++
  ) {
    const parts =
      new Intl.DateTimeFormat(
        "en-CA",
        {
          timeZone:
            DEFAULT_TIMEZONE,

          year:
            "numeric",

          month:
            "2-digit",

          day:
            "2-digit",

          hour:
            "2-digit",

          minute:
            "2-digit",

          second:
            "2-digit",

          hourCycle:
            "h23",
        }
      ).formatToParts(
        guess
      );

    const map = {};

    for (
      const part of parts
    ) {
      if (
        part.type !==
        "literal"
      ) {
        map[
          part.type
        ] =
          part.value;
      }
    }

    const representedLocalAsUtc =
      Date.UTC(
        Number(map.year),
        Number(map.month) - 1,
        Number(map.day),
        Number(map.hour),
        Number(map.minute),
        Number(map.second)
      );

    const offsetMs =
      representedLocalAsUtc -
      guess.getTime();

    guess =
      new Date(
        localAsUtc -
        offsetMs
      );
  }

  return guess.toISOString();
}

// =====================================
// BOOKING DEDUP
// =====================================

function getBookingDedupKey(
  phone,
  startUtc
) {
  const fingerprint = [
    String(
      CAL_EVENT_TYPE_ID
    ),

    String(
      phone || ""
    ),

    String(
      startUtc || ""
    ),
  ].join("|");

  const hash =
    crypto
      .createHash(
        "sha256"
      )
      .update(
        fingerprint
      )
      .digest("hex");

  return `booking_dedup:${hash}`;
}

function getBookingDedupRefKey(
  bookingId
) {
  return `booking_dedup_ref:${bookingId}`;
}

async function readBookingDedup(
  env,
  dedupKey
) {
  const raw =
    await env.SMS_DEDUP.get(
      dedupKey
    );

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    await env.SMS_DEDUP.delete(
      dedupKey
    );

    return null;
  }
}

async function clearBookingDedupForBooking(
  env,
  bookingId
) {
  if (!bookingId) {
    return false;
  }

  const refKey =
    getBookingDedupRefKey(
      String(
        bookingId
      )
    );

  const dedupKey =
    await env.SMS_DEDUP.get(
      refKey
    );

  if (!dedupKey) {
    return false;
  }

  await Promise.all([
    env.SMS_DEDUP.delete(
      dedupKey
    ),

    env.SMS_DEDUP.delete(
      refKey
    ),
  ]);

  console.log(
    "Usunięto booking dedup"
  );

  return true;
}

// =====================================
// CAL.COM API HELPERY
// =====================================

async function calApiRequest(
  env,
  path,
  options = {}
) {
  const response =
    await fetch(
      `https://api.cal.com${path}`,
      {
        ...options,

        headers: {
          Authorization:
            `Bearer ${env.CAL_API_KEY}`,

          "cal-api-version":
            CAL_API_VERSION,

          "Content-Type":
            "application/json",

          ...(
            options.headers ||
            {}
          ),
        },
      }
    );

  const text =
    await response.text();

  let data;

  try {
    data =
      JSON.parse(text);
  } catch {
    data = {
      raw: text,
    };
  }

  return {
    response,
    data,
  };
}

function bookingPhoneMatches(
  booking,
  normalizedPhone
) {
  const attendees =
    Array.isArray(
      booking?.attendees
    )
      ? booking.attendees
      : [];

  return attendees.some(
    (attendee) => {
      const attendeePhone =
        normalizePolishPhone(
          attendee
            ?.phoneNumber
        );

      return (
        attendeePhone ===
        normalizedPhone
      );
    }
  );
}

async function fetchUpcomingBookings(
  env
) {
  const {
    response,
    data,
  } =
    await calApiRequest(
      env,
      "/v2/bookings?status=upcoming",
      {
        method: "GET",
      }
    );

  if (!response.ok) {
    return {
      ok: false,
      status:
        response.status,
      data,
      bookings: [],
    };
  }

  return {
    ok: true,
    status:
      response.status,

    data,

    bookings:
      Array.isArray(
        data?.data
      )
        ? data.data
        : [],
  };
}

// =====================================
// RETELL: FIND MY BOOKINGS
// =====================================

async function handleFindMyBookings(
  request,
  env,
  url
) {
  if (
    !env.RETELL_BOOKING_KEY ||
    !env.CAL_API_KEY
  ) {
    return jsonResponse(
      {
        success: false,
        error:
          "Server configuration missing",
      },
      500
    );
  }

  if (
    !isAuthorizedRetell(
      env,
      url
    )
  ) {
    return jsonResponse(
      {
        success: false,
        error:
          "Unauthorized",
      },
      401
    );
  }

  let body;

  try {
    body =
      await request.json();
  } catch {
    return jsonResponse(
      {
        success: false,
        error:
          "Invalid JSON",
      },
      400
    );
  }

  const phone =
    normalizePolishPhone(
      cleanString(
        body.phone
      )
    );

  if (!phone) {
    return jsonResponse(
      {
        success: false,
        error:
          "Nieprawidłowy numer telefonu",
      },
      400
    );
  }

  const result =
    await fetchUpcomingBookings(
      env
    );

  if (!result.ok) {
    console.error(
      "Find bookings -> Cal.com error:",
      result.status
    );

    return jsonResponse(
      {
        success: false,
        error:
          "Nie udało się pobrać rezerwacji",
        status:
          result.status,
      },
      502
    );
  }

  const matchingBookings =
    result.bookings
      .filter(
        (booking) =>
          Number(
            booking
              ?.eventTypeId
          ) ===
            CAL_EVENT_TYPE_ID &&
          String(
            booking?.status ||
            ""
          ).toLowerCase() ===
            "accepted" &&
          bookingPhoneMatches(
            booking,
            phone
          )
      )
      .map(
        (booking) => {
          const formatted =
            formatBookingForRetell(
              booking.start
            );

          return {
            booking_uid:
              booking.uid,

            date:
              formatted.date,

            time:
              formatted.time,

            start:
              booking.start,

            duration:
              booking.duration ||
              60,

            service:
              cleanString(
                booking.description
              ) ||
              cleanString(
                booking.title
              ) ||
              "Wizyta",
          };
        }
      )
      .sort(
        (a, b) =>
          new Date(
            a.start
          ).getTime() -
          new Date(
            b.start
          ).getTime()
      );

  console.log(
    "Retell find bookings:",
    {
      count:
        matchingBookings.length,
    }
  );

  return jsonResponse({
    success: true,

    bookings_found:
      matchingBookings.length,

    bookings:
      matchingBookings,
  });
}

// =====================================
// RETELL: CANCEL MY BOOKING
// =====================================

async function handleCancelMyBooking(
  request,
  env,
  url
) {
  if (
    !env.RETELL_BOOKING_KEY ||
    !env.CAL_API_KEY
  ) {
    return jsonResponse(
      {
        success: false,
        error:
          "Server configuration missing",
      },
      500
    );
  }

  if (
    !isAuthorizedRetell(
      env,
      url
    )
  ) {
    return jsonResponse(
      {
        success: false,
        error:
          "Unauthorized",
      },
      401
    );
  }

  let body;

  try {
    body =
      await request.json();
  } catch {
    return jsonResponse(
      {
        success: false,
        error:
          "Invalid JSON",
      },
      400
    );
  }

  const phone =
    normalizePolishPhone(
      cleanString(
        body.phone
      )
    );

  const bookingUid =
    cleanString(
      body.booking_uid
    );

  let cancellationReason =
    cleanString(
      body.cancellation_reason
    );

  if (!phone) {
    return jsonResponse(
      {
        success: false,
        error:
          "Nieprawidłowy numer telefonu",
      },
      400
    );
  }

  if (!bookingUid) {
    return jsonResponse(
      {
        success: false,
        error:
          "Brak identyfikatora rezerwacji",
      },
      400
    );
  }

  if (!cancellationReason) {
    cancellationReason =
      "Anulowanie na prośbę klienta";
  }

  if (
    cancellationReason.length >
    250
  ) {
    cancellationReason =
      cancellationReason.slice(
        0,
        250
      );
  }

  // =====================================
  // BEZPIECZEŃSTWO
  // =====================================

  const result =
    await fetchUpcomingBookings(
      env
    );

  if (!result.ok) {
    console.error(
      "Cancel verification -> Cal.com error:",
      result.status
    );

    return jsonResponse(
      {
        success: false,

        error:
          "Nie udało się zweryfikować rezerwacji",

        status:
          result.status,
      },
      502
    );
  }

  const booking =
    result.bookings.find(
      (item) =>
        item?.uid ===
          bookingUid &&
        Number(
          item?.eventTypeId
        ) ===
          CAL_EVENT_TYPE_ID &&
        String(
          item?.status ||
          ""
        ).toLowerCase() ===
          "accepted" &&
        bookingPhoneMatches(
          item,
          phone
        )
    );

  if (!booking) {
    console.warn(
      "Odrzucono anulowanie - brak zgodności danych rezerwacji"
    );

    return jsonResponse(
      {
        success: false,

        error:
          "Nie znaleziono pasującej aktywnej rezerwacji",
      },
      404
    );
  }

  const {
    response,
    data,
  } =
    await calApiRequest(
      env,
      `/v2/bookings/${encodeURIComponent(
        bookingUid
      )}/cancel`,
      {
        method: "POST",

        body:
          JSON.stringify({
            cancellationReason,
          }),
      }
    );

  console.log(
    "Retell cancel -> Cal.com:",
    {
      status:
        response.status,
    }
  );

  if (!response.ok) {
    return jsonResponse(
      {
        success: false,

        error:
          "Nie udało się anulować rezerwacji",

        status:
          response.status,

        cal_error:
          data,
      },

      response.status >=
        400 &&
      response.status <
        600
        ? response.status
        : 502
    );
  }

  const cancelledBooking =
    data?.data || {};

  return jsonResponse({
    success: true,

    booking_uid:
      cancelledBooking.uid ||
      bookingUid,

    status:
      cancelledBooking.status ||
      "cancelled",

    cancellation_reason:
      cancellationReason,

    message:
      "Wizyta została anulowana",
  });
}

// =====================================
// RETELL: RESCHEDULE MY BOOKING
// =====================================

async function handleRescheduleMyBooking(
  request,
  env,
  url
) {
  if (
    !env.RETELL_BOOKING_KEY ||
    !env.CAL_API_KEY
  ) {
    return jsonResponse(
      {
        success: false,
        error:
          "Server configuration missing",
      },
      500
    );
  }

  if (
    !isAuthorizedRetell(
      env,
      url
    )
  ) {
    return jsonResponse(
      {
        success: false,
        error:
          "Unauthorized",
      },
      401
    );
  }

  let body;

  try {
    body =
      await request.json();
  } catch {
    return jsonResponse(
      {
        success: false,
        error:
          "Invalid JSON",
      },
      400
    );
  }

  const phone =
    normalizePolishPhone(
      cleanString(
        body.phone
      )
    );

  const bookingUid =
    cleanString(
      body.booking_uid
    );

  const newTime =
    cleanString(
      body.new_time
    );

  const timezone =
    cleanString(
      body.timezone
    ) ||
    DEFAULT_TIMEZONE;

  let reschedulingReason =
    cleanString(
      body.rescheduling_reason
    );

  if (!phone) {
    return jsonResponse(
      {
        success: false,
        error:
          "Nieprawidłowy numer telefonu",
      },
      400
    );
  }

  if (!bookingUid) {
    return jsonResponse(
      {
        success: false,
        error:
          "Brak identyfikatora rezerwacji",
      },
      400
    );
  }

  if (!newTime) {
    return jsonResponse(
      {
        success: false,
        error:
          "Brak nowego terminu",
      },
      400
    );
  }

  if (
    timezone !==
    DEFAULT_TIMEZONE
  ) {
    return jsonResponse(
      {
        success: false,
        error:
          "Nieprawidłowa strefa czasowa",
      },
      400
    );
  }

  if (!reschedulingReason) {
    reschedulingReason =
      "Zmiana terminu na prośbę klienta";
  }

  if (
    reschedulingReason.length >
    250
  ) {
    reschedulingReason =
      reschedulingReason.slice(
        0,
        250
      );
  }

  const newStartUtc =
    warsawLocalIsoToUtc(
      newTime
    );

  if (!newStartUtc) {
    return jsonResponse(
      {
        success: false,
        error:
          "Nieprawidłowa data nowego terminu",
      },
      400
    );
  }

  if (
    new Date(
      newStartUtc
    ).getTime() <=
    Date.now()
  ) {
    return jsonResponse(
      {
        success: false,
        error:
          "Nowy termin musi być w przyszłości",
      },
      400
    );
  }

  const result =
    await fetchUpcomingBookings(
      env
    );

  if (!result.ok) {
    console.error(
      "Reschedule verification -> Cal.com error:",
      result.status
    );

    return jsonResponse(
      {
        success: false,
        error:
          "Nie udało się zweryfikować rezerwacji",
        status:
          result.status,
      },
      502
    );
  }

  const booking =
    result.bookings.find(
      (item) =>
        item?.uid ===
          bookingUid &&
        Number(
          item?.eventTypeId
        ) ===
          CAL_EVENT_TYPE_ID &&
        String(
          item?.status ||
          ""
        ).toLowerCase() ===
          "accepted" &&
        bookingPhoneMatches(
          item,
          phone
        )
    );

  if (!booking) {
    console.warn(
      "Odrzucono przełożenie - brak zgodności danych rezerwacji"
    );

    return jsonResponse(
      {
        success: false,
        error:
          "Nie znaleziono pasującej aktywnej rezerwacji",
      },
      404
    );
  }

  const oldStart =
    booking.start ||
    null;

  if (
    oldStart &&
    new Date(oldStart).getTime() ===
      new Date(newStartUtc).getTime()
  ) {
    return jsonResponse(
      {
        success: false,
        error:
          "Nowy termin jest taki sam jak obecny",
      },
      400
    );
  }

  const {
    response,
    data,
  } =
    await calApiRequest(
      env,
      `/v2/bookings/${encodeURIComponent(
        bookingUid
      )}/reschedule`,
      {
        method: "POST",

        headers: {
          "cal-api-version":
            CAL_RESCHEDULE_API_VERSION,
        },

        body:
          JSON.stringify({
            start:
              newStartUtc,
            reschedulingReason,
          }),
      }
    );

  console.log(
    "Retell reschedule -> Cal.com:",
    {
      status:
        response.status,
    }
  );

  if (!response.ok) {
    return jsonResponse(
      {
        success: false,
        error:
          "Nie udało się przełożyć rezerwacji",
        status:
          response.status,
        cal_error:
          data,
      },
      response.status >= 400 &&
      response.status < 600
        ? response.status
        : 502
    );
  }

  const rescheduledBooking =
    data?.data ||
    {};

  const returnedStart =
    rescheduledBooking.start ||
    newStartUtc;

  const oldFormatted =
    oldStart
      ? formatBookingForRetell(
          oldStart
        )
      : null;

  const newFormatted =
    formatBookingForRetell(
      returnedStart
    );

  return jsonResponse({
    success: true,

    old_booking_uid:
      bookingUid,

    booking_uid:
      rescheduledBooking.uid ||
      bookingUid,

    old_date:
      oldFormatted?.date ||
      null,

    old_time:
      oldFormatted?.time ||
      null,

    date:
      newFormatted.date,

    time:
      newFormatted.time,

    start:
      returnedStart,

    timezone:
      DEFAULT_TIMEZONE,

    rescheduling_reason:
      reschedulingReason,

    message:
      "Wizyta została przełożona",
  });
}

// =====================================
// WERYFIKACJA WEBHOOKA CAL.COM
// =====================================

function verifyCalSignature(
  rawBody,
  signatureHeader,
  secret
) {
  if (
    !secret ||
    !signatureHeader
  ) {
    return false;
  }

  const expectedHex =
    crypto
      .createHmac(
        "sha256",
        secret
      )
      .update(
        rawBody
      )
      .digest(
        "hex"
      );

  const receivedHex =
    String(
      signatureHeader
    )
      .trim()
      .replace(
        /^sha256=/i,
        ""
      );

  if (
    !/^[a-f0-9]{64}$/i.test(
      receivedHex
    ) ||
    !/^[a-f0-9]{64}$/i.test(
      expectedHex
    )
  ) {
    return false;
  }

  const receivedBuffer =
    Buffer.from(
      receivedHex,
      "hex"
    );

  const expectedBuffer =
    Buffer.from(
      expectedHex,
      "hex"
    );

  if (
    receivedBuffer.length !==
    expectedBuffer.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    receivedBuffer,
    expectedBuffer
  );
}

// =====================================
// ZADARMA
// =====================================

async function sendZadarmaSms(
  env,
  phone,
  message
) {
  if (
    isSmsTestMode(env)
  ) {
    console.log(
      "SMS_TEST_MODE=true - SMS pominięty"
    );

    return {
      ok: true,
      status: 200,

      text:
        JSON.stringify({
          success:
            true,

          test_mode:
            true,

          skipped:
            true,

          message:
            "SMS pominięty w trybie testowym",
        }),

      skipped: true,
    };
  }

  const params = {
    message,

    number:
      normalizePhone(
        phone
      ),

    sender:
      env.ZADARMA_SMS_SENDER,
  };

  const paramsStr =
    buildParams(
      params
    );

  console.log(
    "Wysyłka SMS przez Zadarma"
  );

  const paramsMd5 =
    crypto
      .createHash(
        "md5"
      )
      .update(
        paramsStr
      )
      .digest(
        "hex"
      );

  const signatureData =
    "/v1/sms/send/" +
    paramsStr +
    paramsMd5;

  const hmacHex =
    crypto
      .createHmac(
        "sha1",
        env.ZADARMA_SECRET
      )
      .update(
        signatureData
      )
      .digest(
        "hex"
      );

  const signature =
    btoa(
      hmacHex
    );

  const response =
    await fetch(
      "https://api.zadarma.com/v1/sms/send/",
      {
        method:
          "POST",

        headers: {
          Authorization:
            `${env.ZADARMA_KEY}:${signature}`,

          "Content-Type":
            "application/x-www-form-urlencoded",
        },

        body:
          paramsStr,
      }
    );

  const responseText =
    await response.text();

  console.log(
    "Zadarma status:",
    response.status
  );

  return {
    ok:
      response.ok,

    status:
      response.status,

    text:
      responseText,
  };
}

// =====================================
// RETRY SMS
// =====================================

async function deleteSmsRetry(
  env,
  type,
  bookingId
) {
  if (!bookingId) {
    return;
  }

  await env.SMS_DEDUP.delete(
    getRetryKey(
      type,
      bookingId
    )
  );
}

async function clearOldBookingRetries(
  env,
  bookingId
) {
  if (!bookingId) {
    return;
  }

  await Promise.all([
    deleteSmsRetry(
      env,
      "confirmation",
      bookingId
    ),

    deleteSmsRetry(
      env,
      "reminder",
      bookingId
    ),

    deleteSmsRetry(
      env,
      "reschedule",
      bookingId
    ),
  ]);
}

async function queueSmsRetry(
  env,
  {
    type,
    bookingId,
    phone,
    message,
    successKey,
    attempts = 1,
  }
) {
  if (
    !type ||
    !bookingId ||
    !phone ||
    !message ||
    !successKey
  ) {
    return false;
  }

  const retryKey =
    getRetryKey(
      type,
      bookingId
    );

  const existing =
    await env.SMS_DEDUP.get(
      retryKey
    );

  if (existing) {
    console.log(
      "Retry już istnieje:",
      type
    );

    return true;
  }

  await env.SMS_DEDUP.put(
    retryKey,

    JSON.stringify({
      type,

      bookingId:
        String(
          bookingId
        ),

      phone,
      message,
      successKey,
      attempts,

      nextAttemptAt:
        Date.now() +
        RETRY_DELAY_MS,

      createdAt:
        new Date()
          .toISOString(),
    }),

    {
      expirationTtl:
        RETRY_TTL_SECONDS,
    }
  );

  console.log(
    "SMS dodany do retry:",
    type
  );

  return true;
}

async function markSmsFailed(
  env,
  type,
  bookingId,
  attempts,
  status
) {
  const failedKey =
    getFailedKey(
      type,
      bookingId
    );

  await env.SMS_DEDUP.put(
    failedKey,

    JSON.stringify({
      status:
        "failed",

      attempts,

      lastStatus:
        status ||
        null,

      failedAt:
        new Date()
          .toISOString(),
    }),

    {
      expirationTtl:
        FAILED_TTL_SECONDS,
    }
  );

  console.error(
    "SMS oznaczony jako FAILED:",
    type
  );
}

async function processSmsRetries(
  env
) {
  try {
    let cursor =
      undefined;

    const nowMs =
      Date.now();

    do {
      const list =
        await env.SMS_DEDUP.list({
          prefix:
            "sms_retry:",

          cursor,

          limit:
            1000,
        });

      for (
        const item of
        list.keys
      ) {
        const raw =
          await env.SMS_DEDUP.get(
            item.name
          );

        if (!raw) {
          continue;
        }

        let retry;

        try {
          retry =
            JSON.parse(
              raw
            );
        } catch {
          await env.SMS_DEDUP.delete(
            item.name
          );

          continue;
        }

        if (
          Number(
            retry.nextAttemptAt
          ) > nowMs
        ) {
          continue;
        }

        const alreadySent =
          await env.SMS_DEDUP.get(
            retry.successKey
          );

        if (
          alreadySent
        ) {
          await env.SMS_DEDUP.delete(
            item.name
          );

          continue;
        }

        const smsResult =
          await sendZadarmaSms(
            env,
            retry.phone,
            retry.message
          );

        if (
          smsResult.ok
        ) {
          await env.SMS_DEDUP.put(
            retry.successKey,

            JSON.stringify(
              smsDeliveryRecord(
                smsResult,
                {
                  viaRetry:
                    true,
                }
              )
            ),

            {
              expirationTtl:
                KV_TTL_90_DAYS,
            }
          );

          await env.SMS_DEDUP.delete(
            item.name
          );

          console.log(
            "Retry SMS udany:",
            retry.type
          );

          continue;
        }

        const newAttempts =
          Number(
            retry.attempts ||
            1
          ) + 1;

        if (
          newAttempts >=
          MAX_SMS_ATTEMPTS
        ) {
          await markSmsFailed(
            env,
            retry.type,
            retry.bookingId,
            newAttempts,
            smsResult.status
          );

          await env.SMS_DEDUP.delete(
            item.name
          );

          continue;
        }

        retry.attempts =
          newAttempts;

        retry.nextAttemptAt =
          Date.now() +
          RETRY_DELAY_MS;

        await env.SMS_DEDUP.put(
          item.name,

          JSON.stringify(
            retry
          ),

          {
            expirationTtl:
              RETRY_TTL_SECONDS,
          }
        );

        console.log(
          "Retry SMS nadal oczekuje:",
          retry.type,
          "próba",
          newAttempts
        );
      }

      cursor =
        list.list_complete
          ? undefined
          : list.cursor;

    } while (
      cursor
    );

  } catch (error) {
    console.error(
      "SMS retry error:",
      error?.name || "Error"
    );
  }
}

// =====================================
// REMINDERY
// =====================================

async function deleteScheduleForBooking(
  env,
  bookingId
) {
  if (!bookingId) {
    return false;
  }

  let cursor =
    undefined;

  let deleted =
    false;

  do {
    const list =
      await env.SMS_DEDUP.list({
        prefix:
          "schedule:",

        cursor,

        limit:
          1000,
      });

    for (
      const item of
      list.keys
    ) {
      if (
        item.name.endsWith(
          `:${String(
            bookingId
          )}`
        )
      ) {
        await env.SMS_DEDUP.delete(
          item.name
        );

        console.log(
          "Usunięto schedule"
        );

        deleted =
          true;
      }
    }

    cursor =
      list.list_complete
        ? undefined
        : list.cursor;

  } while (
    cursor
  );

  return deleted;
}

async function scheduleReminder(
  env,
  bookingId,
  phone,
  eventTitle,
  startTime
) {
  if (
    isSmsTestMode(
      env
    )
  ) {
    console.log(
      "SMS_TEST_MODE=true - reminder nie został zaplanowany"
    );

    return false;
  }

  if (
    !bookingId ||
    !phone ||
    !startTime
  ) {
    return false;
  }

  const nowMs =
    Date.now();

  const appointmentMs =
    new Date(
      startTime
    ).getTime();

  const twentyFourHoursMs =
    24 *
    60 *
    60 *
    1000;

  const timeUntilAppointment =
    appointmentMs -
    nowMs;

  if (
    !Number.isFinite(
      appointmentMs
    ) ||
    timeUntilAppointment <=
      twentyFourHoursMs
  ) {
    console.log(
      "Reminder niepotrzebny - wizyta za mniej niż 24 h"
    );

    return false;
  }

  const reminderAt =
    appointmentMs -
    twentyFourHoursMs;

  const scheduleKey =
    `schedule:${reminderAt}:${bookingId}`;

  await env.SMS_DEDUP.put(
    scheduleKey,

    JSON.stringify({
      bookingId:
        String(
          bookingId
        ),

      phone,
      eventTitle,
      startTime,
      reminderAt,
    }),

    {
      expirationTtl:
        KV_TTL_90_DAYS,
    }
  );

  console.log(
    "Reminder zaplanowany"
  );

  return true;
}

// =====================================
// RETELL -> CAL.COM BOOKING
// =====================================

async function handleRetellBooking(
  request,
  env,
  url
) {
  if (
    !env.RETELL_BOOKING_KEY ||
    !env.CAL_API_KEY
  ) {
    return jsonResponse(
      {
        success:
          false,

        error:
          "Server configuration missing",
      },

      500
    );
  }

  if (
    !isAuthorizedRetell(
      env,
      url
    )
  ) {
    return jsonResponse(
      {
        success:
          false,

        error:
          "Unauthorized",
      },

      401
    );
  }

  let body;

  try {
    body =
      await request.json();
  } catch {
    return jsonResponse(
      {
        success:
          false,

        error:
          "Invalid JSON",
      },

      400
    );
  }

  const name =
    cleanString(
      body.name
    );

  const rawPhone =
    cleanString(
      body.phone
    );

  const time =
    cleanString(
      body.time
    );

  const timezone =
    cleanString(
      body.timezone
    ) ||
    DEFAULT_TIMEZONE;

  const notes =
    cleanString(
      body.notes
    );

  const finalPrice =
    Number(
      body.final_price
    );

  if (!name) {
    return jsonResponse(
      {
        success:
          false,

        error:
          "Brak imienia i nazwiska",
      },

      400
    );
  }

  const phone =
    normalizePolishPhone(
      rawPhone
    );

  if (!phone) {
    return jsonResponse(
      {
        success:
          false,

        error:
          "Nieprawidłowy numer telefonu",
      },

      400
    );
  }

  if (!time) {
    return jsonResponse(
      {
        success:
          false,

        error:
          "Brak godziny wizyty",
      },

      400
    );
  }

  if (
    timezone !==
    DEFAULT_TIMEZONE
  ) {
    return jsonResponse(
      {
        success:
          false,

        error:
          "Nieprawidłowa strefa czasowa",
      },

      400
    );
  }

  if (!notes) {
    return jsonResponse(
      {
        success:
          false,

        error:
          "Brak opisu wizyty",
      },

      400
    );
  }

  if (
    !Number.isFinite(
      finalPrice
    ) ||
    finalPrice <=
      0
  ) {
    return jsonResponse(
      {
        success:
          false,

        error:
          "Nieprawidłowa cena",
      },

      400
    );
  }

  const startUtc =
    warsawLocalIsoToUtc(
      time
    );

  if (!startUtc) {
    return jsonResponse(
      {
        success:
          false,

        error:
          "Nieprawidłowa data wizyty",
      },

      400
    );
  }

  const additionalNotes =
    buildAdditionalNotes(
      notes,
      finalPrice
    );

  const dedupKey =
    getBookingDedupKey(
      phone,
      startUtc
    );

  let existingDedup =
    await readBookingDedup(
      env,
      dedupKey
    );

  if (
    existingDedup
      ?.status ===
    "success"
  ) {
    console.log(
      "Retell booking duplicate - zwracam istniejący wynik"
    );

    return jsonResponse({
      ...existingDedup.response,

      success:
        true,

      duplicate:
        true,

      message:
        "Wizyta była już zarezerwowana",
    });
  }

  if (
    existingDedup
      ?.status ===
    "processing"
  ) {
    for (
      let i = 0;
      i <
      BOOKING_PROCESSING_MAX_POLLS;
      i++
    ) {
      await sleep(
        BOOKING_PROCESSING_POLL_MS
      );

      existingDedup =
        await readBookingDedup(
          env,
          dedupKey
        );

      if (
        existingDedup
          ?.status ===
        "success"
      ) {
        console.log(
          "Retell booking duplicate - pierwsza próba zakończona sukcesem"
        );

        return jsonResponse({
          ...existingDedup.response,

          success:
            true,

          duplicate:
            true,

          message:
            "Wizyta była już zarezerwowana",
        });
      }

      if (
        !existingDedup
      ) {
        break;
      }
    }

    if (
      existingDedup
        ?.status ===
      "processing"
    ) {
      return jsonResponse(
        {
          success:
            false,

          booking_in_progress:
            true,

          error:
            "Booking is already being processed",
        },

        409
      );
    }
  }

  await env.SMS_DEDUP.put(
    dedupKey,

    JSON.stringify({
      status:
        "processing",

      createdAt:
        new Date()
          .toISOString(),
    }),

    {
      expirationTtl:
        BOOKING_PROCESSING_TTL_SECONDS,
    }
  );

  const calPayload = {
    start:
      startUtc,

    eventTypeId:
      CAL_EVENT_TYPE_ID,

    attendee: {
      name,

      phoneNumber:
        phone,

      timeZone:
        DEFAULT_TIMEZONE,

      language:
        "pl",
    },

    bookingFieldsResponses: {
      notes:
        additionalNotes,
    },
  };

  const startedAt =
    Date.now();

  let response;

  try {
    response =
      await fetch(
        "https://api.cal.com/v2/bookings",
        {
          method:
            "POST",

          headers: {
            Authorization:
              `Bearer ${env.CAL_API_KEY}`,

            "cal-api-version":
              CAL_API_VERSION,

            "Content-Type":
              "application/json",
          },

          body:
            JSON.stringify(
              calPayload
            ),
        }
      );
  } catch (error) {
    await env.SMS_DEDUP.delete(
      dedupKey
    );

    throw error;
  }

  const responseText =
    await response.text();

  let calResult;

  try {
    calResult =
      JSON.parse(
        responseText
      );
  } catch {
    calResult = {
      raw:
        responseText,
    };
  }

  console.log(
    "Retell booking → Cal.com:",
    {
      status:
        response.status,

      duration_ms:
        Date.now() -
        startedAt,
    }
  );

  if (
    response.ok
  ) {
    const data =
      calResult.data ||
      {};

    const successResponse = {
      success:
        true,

      booking_id:
        data.id ||
        null,

      booking_uid:
        data.uid ||
        null,

      start:
        data.start ||
        startUtc,

      phone,

      notes:
        additionalNotes,

      final_price:
        finalPrice,

      message:
        "Wizyta została zarezerwowana",
    };

    await env.SMS_DEDUP.put(
      dedupKey,

      JSON.stringify({
        status:
          "success",

        savedAt:
          new Date()
            .toISOString(),

        response:
          successResponse,
      }),

      {
        expirationTtl:
          BOOKING_DEDUP_TTL_SECONDS,
      }
    );

    if (
      data.id
    ) {
      await env.SMS_DEDUP.put(
        getBookingDedupRefKey(
          String(
            data.id
          )
        ),

        dedupKey,

        {
          expirationTtl:
            BOOKING_DEDUP_TTL_SECONDS,
        }
      );
    }

    return jsonResponse(
      successResponse
    );
  }

  await env.SMS_DEDUP.delete(
    dedupKey
  );

  return jsonResponse(
    {
      success:
        false,

      error:
        "Cal.com booking failed",

      status:
        response.status,

      cal_error:
        calResult,
    },

    response.status >=
      400 &&
    response.status <
      600
      ? response.status
      : 502
  );
}

// =====================================
// WORKER
// =====================================

export default {
  async fetch(
    request,
    env
  ) {
    const url =
      new URL(
        request.url
      );

    if (
      url.pathname ===
      "/retell/book"
    ) {
      if (
        request.method !==
        "POST"
      ) {
        return jsonResponse(
          {
            success:
              false,

            error:
              "Method not allowed",
          },

          405
        );
      }

      try {
        return await handleRetellBooking(
          request,
          env,
          url
        );
      } catch (error) {
        console.error(
          "Retell booking error:",
          error?.name || "Error"
        );

        return jsonResponse(
          {
            success:
              false,

            error:
              "Internal worker error",
          },

          500
        );
      }
    }

    if (
      url.pathname ===
      "/retell/bookings"
    ) {
      if (
        request.method !==
        "POST"
      ) {
        return jsonResponse(
          {
            success:
              false,

            error:
              "Method not allowed",
          },

          405
        );
      }

      try {
        return await handleFindMyBookings(
          request,
          env,
          url
        );
      } catch (error) {
        console.error(
          "Retell find bookings error:",
          error?.name || "Error"
        );

        return jsonResponse(
          {
            success:
              false,

            error:
              "Internal worker error",
          },

          500
        );
      }
    }

    if (
      url.pathname ===
      "/retell/cancel"
    ) {
      if (
        request.method !==
        "POST"
      ) {
        return jsonResponse(
          {
            success:
              false,

            error:
              "Method not allowed",
          },

          405
        );
      }

      try {
        return await handleCancelMyBooking(
          request,
          env,
          url
        );
      } catch (error) {
        console.error(
          "Retell cancel error:",
          error?.name || "Error"
        );

        return jsonResponse(
          {
            success:
              false,

            error:
              "Internal worker error",
          },

          500
        );
      }
    }

    if (
      url.pathname ===
      "/retell/reschedule"
    ) {
      if (
        request.method !==
        "POST"
      ) {
        return jsonResponse(
          {
            success:
              false,

            error:
              "Method not allowed",
          },

          405
        );
      }

      try {
        return await handleRescheduleMyBooking(
          request,
          env,
          url
        );
      } catch (error) {
        console.error(
          "Retell reschedule error:",
          error?.name || "Error"
        );

        return jsonResponse(
          {
            success:
              false,

            error:
              "Internal worker error",
          },

          500
        );
      }
    }

    if (
      request.method !==
      "POST"
    ) {
      return new Response(
        "Worker działa",
        {
          status:
            200,
        }
      );
    }

    try {
      const rawBody =
        await request.text();

      const calSignature =
        request.headers.get(
          "x-cal-signature-256"
        );

      const validSignature =
        verifyCalSignature(
          rawBody,
          calSignature,
          env.CALCOM_WEBHOOK_SECRET
        );

      if (
        !validSignature
      ) {
        console.warn(
          "Odrzucono webhook - nieprawidłowy podpis"
        );

        return jsonResponse(
          {
            success:
              false,

            error:
              "Invalid webhook signature",
          },

          401
        );
      }

      let data;

      try {
        data =
          JSON.parse(
            rawBody
          );
      } catch {
        return jsonResponse(
          {
            success:
              false,

            error:
              "Invalid JSON payload",
          },

          400
        );
      }

      console.log(
        "Cal.com event:",
        data.triggerEvent
      );

      const booking =
        data.payload ||
        {};

      if (
        data.triggerEvent ===
        "BOOKING_CANCELLED"
      ) {
        const cancelledBookingId =
          booking.bookingId ||
          booking.rescheduleId ||
          booking.uid ||
          booking.iCalUID;

        const attendee =
          booking.attendees?.[
            0
          ];

        const phone =
          attendee
            ?.phoneNumber;

        const eventTitle =
          booking.eventTitle ||
          booking.eventTypeTitle ||
          "Wizyta";

        if (
          cancelledBookingId
        ) {
          await deleteScheduleForBooking(
            env,
            cancelledBookingId
          );

          await clearOldBookingRetries(
            env,
            cancelledBookingId
          );

          await clearBookingDedupForBooking(
            env,
            cancelledBookingId
          );
        }

        const successKey =
          `cancellation:${cancelledBookingId}`;

        const retryKey =
          getRetryKey(
            "cancellation",
            cancelledBookingId
          );

        const existingSuccess =
          await env.SMS_DEDUP.get(
            successKey
          );

        const existingRetry =
          await env.SMS_DEDUP.get(
            retryKey
          );

        if (
          !existingSuccess &&
          !existingRetry &&
          phone &&
          cancelledBookingId
        ) {
          const message =
            `Wizyta ${eventTitle} zostala anulowana. TurboGuma.`;

          const smsResult =
            await sendZadarmaSms(
              env,
              phone,
              message
            );

          if (
            smsResult.ok
          ) {
            await env.SMS_DEDUP.put(
              successKey,

              JSON.stringify(
                smsDeliveryRecord(
                  smsResult
                )
              ),

              {
                expirationTtl:
                  KV_TTL_90_DAYS,
              }
            );
          } else {
            await queueSmsRetry(
              env,

              {
                type:
                  "cancellation",

                bookingId:
                  cancelledBookingId,

                phone,
                message,
                successKey,
              }
            );
          }
        }

        return jsonResponse({
          success:
            true,

          cancellation_handled:
            true,
        });
      }

      if (
        data.triggerEvent ===
        "BOOKING_RESCHEDULED"
      ) {
        const oldBookingId =
          booking
            .rescheduleId;

        const newBookingId =
          booking.bookingId ||
          booking.uid ||
          booking.iCalUID;

        const attendee =
          booking.attendees?.[
            0
          ];

        const phone =
          attendee
            ?.phoneNumber;

        const eventTitle =
          booking.eventTitle ||
          booking.eventTypeTitle ||
          "Wizyta";

        const startTime =
          booking.startTime;

        if (
          oldBookingId
        ) {
          await deleteScheduleForBooking(
            env,
            oldBookingId
          );

          await clearOldBookingRetries(
            env,
            oldBookingId
          );

          await clearBookingDedupForBooking(
            env,
            oldBookingId
          );
        }

        if (
          newBookingId &&
          phone &&
          startTime
        ) {
          await scheduleReminder(
            env,
            newBookingId,
            phone,
            eventTitle,
            startTime
          );
        }

        const successKey =
          `reschedule:${newBookingId}`;

        const retryKey =
          getRetryKey(
            "reschedule",
            newBookingId
          );

        const existingSuccess =
          await env.SMS_DEDUP.get(
            successKey
          );

        const existingRetry =
          await env.SMS_DEDUP.get(
            retryKey
          );

        if (
          !existingSuccess &&
          !existingRetry &&
          newBookingId &&
          phone &&
          startTime
        ) {
          const formatted =
            formatAppointment(
              startTime
            );

          const message =
            `Termin wizyty zostal zmieniony. ` +
            `${eventTitle}, ` +
            `${formatted.date}, ` +
            `${formatted.time}. TurboGuma.`;

          const smsResult =
            await sendZadarmaSms(
              env,
              phone,
              message
            );

          if (
            smsResult.ok
          ) {
            await env.SMS_DEDUP.put(
              successKey,

              JSON.stringify(
                smsDeliveryRecord(
                  smsResult
                )
              ),

              {
                expirationTtl:
                  KV_TTL_90_DAYS,
              }
            );
          } else {
            await queueSmsRetry(
              env,

              {
                type:
                  "reschedule",

                bookingId:
                  newBookingId,

                phone,
                message,
                successKey,
              }
            );
          }
        }

        return jsonResponse({
          success:
            true,

          reschedule_handled:
            true,
        });
      }

      if (
        data.triggerEvent !==
        "BOOKING_CREATED"
      ) {
        return jsonResponse({
          success:
            true,

          message:
            "Event pominięty",
        });
      }

      const attendee =
        booking.attendees?.[
          0
        ];

      const phone =
        attendee
          ?.phoneNumber;

      const eventTitle =
        booking.eventTitle ||
        booking.eventTypeTitle ||
        "Wizyta";

      const startTime =
        booking.startTime;

      const additionalNotes =
        booking.additionalNotes ||
        booking.responses
          ?.notes
          ?.value ||
        "";

      const price =
        extractPrice(
          additionalNotes
        );

      const bookingIdentifier =
        booking.bookingId ||
        booking.uid ||
        booking.iCalUID;

      if (
        !bookingIdentifier
      ) {
        return jsonResponse(
          {
            success:
              false,

            error:
              "Brak identyfikatora rezerwacji",
          },

          400
        );
      }

      if (
        !phone ||
        !startTime
      ) {
        return jsonResponse(
          {
            success:
              false,

            error:
              "Brak telefonu lub daty wizyty",
          },

          400
        );
      }

      const confirmationKey =
        `confirmation:${bookingIdentifier}`;

      const retryKey =
        getRetryKey(
          "confirmation",
          bookingIdentifier
        );

      const existingConfirmation =
        await env.SMS_DEDUP.get(
          confirmationKey
        );

      if (
        existingConfirmation
      ) {
        console.log(
          "Potwierdzenie już obsłużone"
        );

        return jsonResponse({
          success:
            true,

          duplicate:
            true,

          message:
            "SMS już wcześniej obsłużony",
        });
      }

      const existingRetry =
        await env.SMS_DEDUP.get(
          retryKey
        );

      if (
        existingRetry
      ) {
        console.log(
          "Potwierdzenie oczekuje już w retry"
        );

        return jsonResponse({
          success:
            true,

          confirmation_sent:
            false,

          confirmation_queued:
            true,
        });
      }

      const formatted =
        formatAppointment(
          startTime
        );

      let confirmationMessage =
        `${eventTitle}, ` +
        `${formatted.date}, ` +
        `${formatted.time}.`;

      if (
        price
      ) {
        confirmationMessage +=
          ` Cena: ${price} zl.`;
      }

      confirmationMessage +=
        ` TurboGuma.`;

      if (
        isSmsTestMode(
          env
        )
      ) {
        console.log(
          "SMS TEST: potwierdzenie pominięte",
          {
            price_included:
              Boolean(price),
          }
        );
      }

      const smsResult =
        await sendZadarmaSms(
          env,
          phone,
          confirmationMessage
        );

      if (
        smsResult.skipped
      ) {
        console.log(
          "Potwierdzenie SMS pominięte przez SMS_TEST_MODE"
        );
      }

      if (
        smsResult.ok
      ) {
        await env.SMS_DEDUP.put(
          confirmationKey,

          JSON.stringify(
            smsDeliveryRecord(
              smsResult
            )
          ),

          {
            expirationTtl:
              KV_TTL_90_DAYS,
          }
        );
      } else {
        await queueSmsRetry(
          env,

          {
            type:
              "confirmation",

            bookingId:
              bookingIdentifier,

            phone,

            message:
              confirmationMessage,

            successKey:
              confirmationKey,
          }
        );
      }

      await scheduleReminder(
        env,
        bookingIdentifier,
        phone,
        eventTitle,
        startTime
      );

      return jsonResponse({
        success:
          true,

        confirmation_sent:
          Boolean(
            smsResult.ok &&
            !smsResult.skipped
          ),

        confirmation_queued:
          Boolean(
            !smsResult.ok
          ),

        sms_test_mode:
          Boolean(
            smsResult.skipped
          ),

        confirmation_skipped:
          Boolean(
            smsResult.skipped
          ),

        price_included:
          Boolean(
            price
          ),
      });

    } catch (error) {
      console.error(
        "Worker fetch error:",
        error?.name || "Error"
      );

      return jsonResponse(
        {
          success:
            false,

          error:
            "Internal worker error",
        },

        500
      );
    }
  },

  async scheduled(
    event,
    env,
    ctx
  ) {
    ctx.waitUntil(
      Promise.all([
        processSmsRetries(
          env
        ),

        processReminders(
          env
        ),
      ])
    );
  },
};

// =====================================
// PROCESS REMINDERS
// =====================================

async function processReminders(
  env
) {
  try {
    let cursor =
      undefined;

    const nowMs =
      Date.now();

    do {
      const list =
        await env.SMS_DEDUP.list({
          prefix:
            "schedule:",

          cursor,

          limit:
            1000,
        });

      for (
        const item of
        list.keys
      ) {
        const keyParts =
          item.name.split(
            ":"
          );

        const reminderAt =
          Number(
            keyParts[1]
          );

        if (
          !Number.isFinite(
            reminderAt
          ) ||
          reminderAt >
            nowMs
        ) {
          continue;
        }

        const raw =
          await env.SMS_DEDUP.get(
            item.name
          );

        if (!raw) {
          continue;
        }

        let reminder;

        try {
          reminder =
            JSON.parse(
              raw
            );
        } catch {
          await env.SMS_DEDUP.delete(
            item.name
          );

          continue;
        }

        const bookingId =
          reminder.bookingId;

        const reminderKey =
          `reminder:${bookingId}`;

        const retryKey =
          getRetryKey(
            "reminder",
            bookingId
          );

        const alreadySent =
          await env.SMS_DEDUP.get(
            reminderKey
          );

        if (
          alreadySent
        ) {
          await env.SMS_DEDUP.delete(
            item.name
          );

          continue;
        }

        const existingRetry =
          await env.SMS_DEDUP.get(
            retryKey
          );

        if (
          existingRetry
        ) {
          await env.SMS_DEDUP.delete(
            item.name
          );

          continue;
        }

        const appointmentMs =
          new Date(
            reminder.startTime
          ).getTime();

        if (
          !Number.isFinite(
            appointmentMs
          ) ||
          appointmentMs <=
            nowMs
        ) {
          console.log(
            "Reminder wygasł"
          );

          await env.SMS_DEDUP.delete(
            item.name
          );

          continue;
        }

        const formatted =
          formatAppointment(
            reminder.startTime
          );

        const reminderMessage =
          `Przypomnienie: ` +
          `${reminder.eventTitle}, ` +
          `${formatted.date}, ` +
          `${formatted.time}. TurboGuma.`;

        const smsResult =
          await sendZadarmaSms(
            env,
            reminder.phone,
            reminderMessage
          );

        if (
          smsResult.ok
        ) {
          await env.SMS_DEDUP.put(
            reminderKey,

            JSON.stringify(
              smsDeliveryRecord(
                smsResult
              )
            ),

            {
              expirationTtl:
                KV_TTL_90_DAYS,
            }
          );

          await env.SMS_DEDUP.delete(
            item.name
          );

          if (
            smsResult.skipped
          ) {
            console.log(
              "Reminder pominięty przez SMS_TEST_MODE"
            );
          } else {
            console.log(
              "Reminder wysłany"
            );
          }
        } else {
          await queueSmsRetry(
            env,

            {
              type:
                "reminder",

              bookingId,

              phone:
                reminder.phone,

              message:
                reminderMessage,

              successKey:
                reminderKey,
            }
          );

          await env.SMS_DEDUP.delete(
            item.name
          );
        }
      }

      cursor =
        list.list_complete
          ? undefined
          : list.cursor;

    } while (
      cursor
    );

  } catch (error) {
    console.error(
      "Reminder cron error:",
      error?.name || "Error"
    );
  }
}
