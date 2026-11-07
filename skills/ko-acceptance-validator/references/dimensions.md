# The four dimensions

The judge in the project's judge file answers these questions from their own job. Read each dimension against the sources the judge file names, and test it against that file's anchor cases.

Every finding is written in the judge's voice, first person and about the job: "When I open this with nothing booked, I can't tell if it's empty or broken." Never "the component lacks an empty state."

## Workflow-fit

The change connects end to end into the job as the judge actually does it, from the entry point they start at to the outcome they need.

1. Where do I actually do this job today, and which surface do I start from?
2. Does the change connect to that entry point and carry through to the outcome, or does it sit somewhere I never work from?
3. If I follow it end to end, does the work move forward or dead-end?

**For an API:** can a caller finish the job with the calls that exist, in the order the docs imply, or is a step missing?

**Typical rejection:** a new screen looks complete but never connects to where the work is actually done.

## Legibility

The judge can tell correct-and-empty from broken. Every state the surface can be in is designed, and the judge can read which one they are looking at. On a form, this also means knowing what each field is and what choosing it will do.

1. When I open this with no data, can I tell "nothing here yet" from "this is broken"?
2. Are loading, empty and error states each distinguishable?
3. If every cell shows a dash, do I know whether that is expected?
4. On a form, does it read in the order I would ask the questions, and does something warn me before a choice changes what happens later?

**For an API:** can a caller tell empty from failure from the status and body alone, and does an error say what to do next?

**Typical rejection:** a grid of dashes with nothing to separate "no one has signed up" from "the data failed to load".

## Intent-match

The change does what was asked, not a narrower slice or an adjacent thing that is easier to build. The test is request against outcome, not code against spec.

1. Did this do the job I asked for, or a smaller or adjacent piece of it?
2. If I trace the change end to end, do I reach the outcome the request named?
3. Is there a gap between what shipped and what I needed to be able to do?

**For an API:** does the endpoint let a caller reach the outcome the request named, or only read part of it?

**Typical rejection:** the request was "let people book a slot" and what shipped was "show the slots".

## Convention-fit

The change matches the surface's established patterns and avoids clutter. A new affordance looks and behaves like the ones already there.

1. Does this look and behave like what is already on this surface, or is it a one-off I have to learn?
2. Does it use the project's established meanings, such as action colors or status words?
3. Does it add clutter, or reuse the pattern the rest of the surface uses?

**For an API:** does it match the established status codes, error shape, naming and pagination?

**Typical rejection:** an input that ships always-open on a surface where every other one collapses behind the same button. Correctness was never the issue.

## Which stage judges what

| Dimension | Spec stage (plan text) | Build stage (running app) |
|---|---|---|
| workflow-fit | judged | judged over scenario outcomes |
| intent-match | judged | judged over scenario outcomes |
| legibility | `not_applicable` | judged over screenshots, rendered DOM or API captures |
| convention-fit | `not_applicable` | judged over screenshots, rendered DOM or API captures |
