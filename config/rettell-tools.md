# Retell AI — Tool Configuration

The TurboGuma voice agent used 8 tools to handle the complete customer-service workflow.

## 1. end_call

**Type:** Retell built-in — End Call

Ends the conversation when the caller indicates that the conversation is finished.

---

## 2. check_availability_cal

**Type:** Retell built-in — Cal.com

Checks available appointment slots.

Configuration:
- Event Type ID: 6668943
- Timezone: Europe/Warsaw
- Appointment duration: 60 minutes

The agent checks availability before attempting to create or reschedule an appointment.

---

## 3. book_appointment_secure

**Type:** Custom HTTP function  
**Method:** POST

Endpoint:

https://polished-block-cfd5.skrabotd.workers.dev/retell/book

Authentication:
- query parameter `key`
- actual key stored as a secret and intentionally omitted from this repository

Purpose:
Creates a Cal.com appointment through the Cloudflare Worker.

The request contains appointment information such as customer details, selected time and service information.

Agent message while executing:

"Dobrze, zapisuję wizytę."

---

## 4. find_my_bookings

**Type:** Custom HTTP function  
**Method:** POST

Endpoint:

https://polished-block-cfd5.skrabotd.workers.dev/retell/bookings

Purpose:
Finds future active appointments associated with the caller's phone number.

Request schema:

{
  "phone": "{{user_number}}"
}

The phone number is taken directly from Retell's system variable instead of being guessed or reconstructed by the agent.

Agent message while executing:

"Już sprawdzam Pana/Pani rezerwację."

---

## 5. cancel_my_booking

**Type:** Custom HTTP function  
**Method:** POST

Endpoint:

https://polished-block-cfd5.skrabotd.workers.dev/retell/cancel

Purpose:
Cancels an existing appointment after explicit customer confirmation.

Required parameters:
- phone
- booking_uid
- cancellation_reason

The `booking_uid` must originate from `find_my_bookings`.

The backend additionally verifies that the booking belongs to the caller before cancelling it.

Agent message while executing:

"Dobrze, anuluję wizytę."

---

## 6. reschedule_my_booking

**Type:** Custom HTTP function  
**Method:** POST

Endpoint:

https://polished-block-cfd5.skrabotd.workers.dev/retell/reschedule

Purpose:
Moves an existing appointment to a new confirmed and previously checked time.

Required parameters:
- phone
- booking_uid
- new_time
- timezone
- rescheduling_reason

Timezone:

Europe/Warsaw

The new appointment time must first be checked using `check_availability_cal`.

The `booking_uid` must originate from `find_my_bookings`.

Agent message while executing:

"Dobrze, zmieniam termin wizyty."

---

## 7. transfer_call

**Type:** Retell built-in — Transfer Call

Transfers the active conversation to a human employee when human intervention is required or explicitly requested by the caller.

Configuration:
- Cold Transfer
- SIP REFER
- Ring duration: 30 seconds
- Destination phone number intentionally omitted from this repository

The agent normally handles standard pricing and appointment operations itself and uses human transfer as a fallback.

---

## 8. get_price

**Type:** Custom HTTP function  
**Method:** POST

Backend:
Google Apps Script + Google Sheets

Purpose:
Calculates the authorized service price using the TurboGuma price table.

Required parameters:

- service
  - `wymiana_opon`
  - `wymiana_kół`

- rim
  - `stalowa`
  - `aluminiowa`

- size
  - `15-16`
  - `17-18`
  - `19+`

- suv
  - boolean

- runflat
  - boolean

The agent must not call the tool when SUV or RunFlat status is unknown.

The pricing API:
1. reads the authorized price table,
2. determines the base price,
3. adds applicable SUV and RunFlat surcharges,
4. returns the final price in PLN.

Agent message while executing:

"Już sprawdzam dokładną cenę."

The AI itself is not treated as the source of truth for pricing.

---

# Security

Production credentials are intentionally excluded.

The system used environment variables / secret stores for credentials including:

- CAL_API_KEY
- CALCOM_WEBHOOK_SECRET
- RETELL_BOOKING_KEY
- ZADARMA_KEY
- ZADARMA_SECRET
- PRICE_API_KEY

No production secret should be committed to the public repository.
