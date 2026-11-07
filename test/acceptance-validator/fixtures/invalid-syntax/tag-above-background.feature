Feature: Backgrounds take no tags

  @route:/orders
  Background:
    Given one thing

  @kind:good @dimension:workflow-fit @route:/orders
  Scenario: Fine
    When I open it
    Then I see it
