import "@typespec/http";
import "@typespec/openapi3";

using TypeSpec.Http;

@service(#{ title: "Call Calendar API" })
namespace Calendar;

@route("/api/health")
@get
op health(): { status: "ok" };

model MeetingTypeInput {
  @minLength(1) @maxLength(100) name: string;
  @minLength(1) @maxLength(1000) description: string;
  @minValue(1) @maxValue(2147483647) durationMinutes: int32;
}
model MeetingType extends MeetingTypeInput {
  id: string;
  version: int32;
}
model ApiError {
  code: string;
  message: string;
  fields?: Record<string>;
}
@route("/api/meeting-types")
interface MeetingTypes {
  @get list(): MeetingType[] | { @statusCode statusCode: 500; @body body: ApiError } | { @statusCode statusCode: 503; @body body: ApiError };
  @post create(@body input: MeetingTypeInput): { @statusCode statusCode: 201; @header etag: string; @body body: MeetingType } | { @statusCode statusCode: 400; @body body: ApiError } | { @statusCode statusCode: 500; @body body: ApiError } | { @statusCode statusCode: 503; @body body: ApiError };
}

@route("/api/meeting-types/{id}")
interface MeetingTypeResource {
  @get read(@path id: string): { @header etag: string; @body body: MeetingType } | { @statusCode statusCode: 404; @body body: ApiError } | { @statusCode statusCode: 500; @body body: ApiError } | { @statusCode statusCode: 503; @body body: ApiError };
  @put update(@path id: string, @header ifMatch?: string, @body input: MeetingTypeInput): { @header etag: string; @body body: MeetingType } | { @statusCode statusCode: 400 | 404 | 412 | 428 | 500 | 503; @body body: ApiError };
  @delete remove(@path id: string, @header ifMatch?: string): { @statusCode statusCode: 204 } | { @statusCode statusCode: 404 | 412 | 428 | 500 | 503; @body body: ApiError };
}

model Slot { startsAt: utcDateTime; endsAt: utcDateTime; available: boolean; }
model SlotsResponse { version: int32; slots: Slot[]; }
model AvailabilityDay { date: string; availableCount: int32; }
model AvailabilityResponse { version: int32; days: AvailabilityDay[]; }
@route("/api/meeting-types/{id}")
interface Availability {
  @route("/availability") @get summary(@path id: string): AvailabilityResponse | { @statusCode statusCode: 404; @body body: ApiError } | { @statusCode statusCode: 500; @body body: ApiError } | { @statusCode statusCode: 503; @body body: ApiError };
  @route("/slots") @get slots(@path id: string, @query date: string): SlotsResponse | { @statusCode statusCode: 400; @body body: ApiError } | { @statusCode statusCode: 404; @body body: ApiError } | { @statusCode statusCode: 500; @body body: ApiError } | { @statusCode statusCode: 503; @body body: ApiError };
}

model BookingInput {
  meetingTypeId: string;
  meetingTypeVersion: int32;
  startsAt: utcDateTime;
  @minLength(1) @maxLength(100) guestName: string;
  @minLength(1) @maxLength(254) guestEmail: string;
}
model Booking {
  id: string;
  meetingTypeId: string;
  meetingTypeName: string;
  meetingTypeDescription: string;
  meetingTypeDurationMinutes: int32;
  startsAt: utcDateTime;
  endsAt: utcDateTime;
  guestName: string;
  guestEmail: string;
  createdAt: utcDateTime;
}
@route("/api/bookings")
@post
op createBooking(@header("Idempotency-Key") key: string, @body input: BookingInput):
  { @statusCode statusCode: 201; @header("Cache-Control") cacheControl: string; @body body: Booking } |
  { @statusCode statusCode: 400; @body body: ApiError } |
  { @statusCode statusCode: 409; @body body: ApiError } |
  { @statusCode statusCode: 500; @body body: ApiError } |
  { @statusCode statusCode: 503; @body body: ApiError };

model UpcomingEvent {
  id: string;
  meetingTypeName: string;
  startsAt: utcDateTime;
  endsAt: utcDateTime;
  guestName: string;
  guestEmail: string;
}
@route("/api/events/upcoming")
@get
op upcomingEvents():
  { @statusCode statusCode: 200; @header("Cache-Control") cacheControl: string; @body body: UpcomingEvent[] } |
  { @statusCode statusCode: 500; @body body: ApiError } |
  { @statusCode statusCode: 503; @body body: ApiError };
