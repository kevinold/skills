Feature: Partners read a booking over the API

  @kind:good @dimension:legibility @route:/api/bookings/:id
  Scenario: A booking with no notes says so
    Given a booking with no notes exists
    When a partner calls GET on the booking
    Then the response status is 200
    And the notes field is an empty list
