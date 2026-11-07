# language: en
# Comments are not tags: @route:/ghost
@route:/orders
Feature: A customer reorders from their order history
  As a customer who buys the same thing every month
  I want to repeat a past order
  so that I do not have to rebuild it

  Background:
    Given I am signed in to my account

  @kind:good @dimension:workflow-fit @route:/orders/:id
  Scenario: Reorder starts from the order I am looking at
    When I open a past order and choose "Order again"
    Then a new order holds the same items
    And I land on checkout

  # @route:/ghost
  @kind:bad @dimension:legibility
  Scenario: An empty history reads like a failure
    When I open my orders with nothing bought yet
    Then I cannot tell "nothing yet" from "this is broken"

  Rule: Past prices never carry over

    @kind:good @dimension:intent-match @route:/checkout
    Example: The reorder uses today's prices
      When I reorder an item whose price changed
      Then the checkout shows the current price:
        | item   | price |
        | filter | 12.50 |

    @kind:good @dimension:convention-fit @route:/admin#orders
    Scenario: The receipt note reads like every other note
      When I open the receipt
      Then the note says:
        """
        Reordered from a past order
        """
