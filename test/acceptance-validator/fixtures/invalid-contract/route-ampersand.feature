Feature: An ampersand would background a shell command

  @kind:good @dimension:workflow-fit @route:/x&./pwn.sh
  Scenario: Case
    Given I have an order
    When I open it
    Then I see it
