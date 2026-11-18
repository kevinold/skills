Feature: A benefit line is not a step keyword

  @kind:good @dimension:workflow-fit @route:/orders
  Scenario: So is not Gherkin
    Given I have an order
    When I open it
    Then I see the status
    So I can tell the customer when it arrives
