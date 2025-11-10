# Result Handling Options with TanStack Server Functions

This document demonstrates different idiomatic ways to handle `Result` types when using TanStack Server Functions with the DDD Kit Query Bus.

## Setup

```typescript
import { Outcome } from "@shirudo/ddd-kit/core/result";
import { isOk } from "@shirudo/ddd-kit/core/result";

const query = jobContainer.get('getJobOccupationQuery');
const authContext = await getAuthContextFromRequest();
```

## Option 1: Using `unwrap()` (Throws Exception on Error)

**Best for:** Simple error handling where exceptions are acceptable.

```typescript
export const getJobOccupationServerFn = createServerFn({
  method: 'GET',
})
  .inputValidator(getJobOccupationRequestSchema)
  .handler(async ({ data }) => {
    const { jobId } = data

    const authContext = await getAuthContextFromRequest()
    if (!authContext) {
      throw new Error('Unauthorized')
    }

    const query = jobContainer.get('getJobOccupationQuery')
    const result = await query.execute({ jobId }, authContext)
    const outcome = Outcome.from(result)

    return outcome.unwrap() // Throws exception on error
  })
```

**Pros:**
- Simple and concise
- Matches exception-based error handling pattern
- Type-safe: TypeScript knows the return type

**Cons:**
- Throws exception, which might not be desired in all cases

---

## Option 2: Using `match()` (Explicit Error Handling)

**Best for:** When you want explicit control over both success and error cases.

```typescript
export const getJobOccupationServerFn = createServerFn({
  method: 'GET',
})
  .inputValidator(getJobOccupationRequestSchema)
  .handler(async ({ data }) => {
    const { jobId } = data

    const authContext = await getAuthContextFromRequest()
    if (!authContext) {
      throw new Error('Unauthorized')
    }

    const query = jobContainer.get('getJobOccupationQuery')
    const result = await query.execute({ jobId }, authContext)
    
    return Outcome.from(result).match(
      (value) => value, // Success: return value
      (error) => { throw new Error(error) } // Error: throw exception
    )
  })
```

**Pros:**
- Explicit handling of both cases
- Clear intent
- Can customize error handling per case

**Cons:**
- More verbose than `unwrap()`

---

## Option 3: Functional API (Without Outcome)

**Best for:** When you prefer functional style without class-based API.

```typescript
import { isOk } from "@shirudo/ddd-kit/core/result"

export const getJobOccupationServerFn = createServerFn({
  method: 'GET',
})
  .inputValidator(getJobOccupationRequestSchema)
  .handler(async ({ data }) => {
    const { jobId } = data

    const authContext = await getAuthContextFromRequest()
    if (!authContext) {
      throw new Error('Unauthorized')
    }

    const query = jobContainer.get('getJobOccupationQuery')
    const result = await query.execute({ jobId }, authContext)
    
    if (!isOk(result)) {
      throw new Error(result.error)
    }
    
    return result.value
  })
```

**Pros:**
- No class instantiation overhead
- Functional programming style
- Direct access to Result type

**Cons:**
- Requires explicit type guard check
- More verbose than Outcome API

---

## Option 4: Using `unwrapOrElse()` (Custom Error Transformation)

**Best for:** When you want to transform errors into custom exceptions or responses.

```typescript
export const getJobOccupationServerFn = createServerFn({
  method: 'GET',
})
  .inputValidator(getJobOccupationRequestSchema)
  .handler(async ({ data }) => {
    const { jobId } = data

    const authContext = await getAuthContextFromRequest()
    if (!authContext) {
      throw new Error('Unauthorized')
    }

    const query = jobContainer.get('getJobOccupationQuery')
    const result = await query.execute({ jobId }, authContext)
    
    return Outcome.from(result).unwrapOrElse((error) => {
      throw new Error(`Query failed: ${error}`)
    })
  })
```

**Pros:**
- Can customize error messages
- Flexible error transformation
- Type-safe

**Cons:**
- Slightly more verbose than `unwrap()`

---

## Option 5: Using `unwrapOr()` (Default Value Fallback)

**Best for:** When you have a sensible default value to return on error.

```typescript
export const getJobOccupationServerFn = createServerFn({
  method: 'GET',
})
  .inputValidator(getJobOccupationRequestSchema)
  .handler(async ({ data }) => {
    const { jobId } = data

    const authContext = await getAuthContextFromRequest()
    if (!authContext) {
      throw new Error('Unauthorized')
    }

    const query = jobContainer.get('getJobOccupationQuery')
    const result = await query.execute({ jobId }, authContext)
    
    return Outcome.from(result).unwrapOr(null) // Returns null on error
  })
```

**Pros:**
- No exceptions thrown
- Provides fallback value
- Good for optional data

**Cons:**
- Requires handling null/undefined in calling code
- Might hide errors unintentionally

---

## Option 6: Method Chaining with Transformations

**Best for:** When you need to transform the result before returning.

```typescript
export const getJobOccupationServerFn = createServerFn({
  method: 'GET',
})
  .inputValidator(getJobOccupationRequestSchema)
  .handler(async ({ data }) => {
    const { jobId } = data

    const authContext = await getAuthContextFromRequest()
    if (!authContext) {
      throw new Error('Unauthorized')
    }

    const query = jobContainer.get('getJobOccupationQuery')
    const result = await query.execute({ jobId }, authContext)
    
    return Outcome.from(result)
      .map(job => ({ ...job, processedAt: new Date() })) // Transform on success
      .mapErr(error => `Failed to fetch job: ${error}`) // Transform error message
      .unwrap() // Get final value or throw
  })
```

**Pros:**
- Composable transformations
- Clean method chaining
- Can transform both success and error cases

**Cons:**
- More complex for simple cases

---

## Recommendation

- **For simple cases:** Use **Option 1** (`unwrap()`) - it's the most straightforward
- **For explicit error handling:** Use **Option 2** (`match()`) - makes both cases clear
- **For functional style:** Use **Option 3** (functional API) - if you prefer not using classes
- **For error transformation:** Use **Option 4** (`unwrapOrElse()`) - when you need custom error messages
- **For default values:** Use **Option 5** (`unwrapOr()`) - when null/undefined is acceptable
- **For transformations:** Use **Option 6** (method chaining) - when you need to transform data

## Important Notes

⚠️ **Never use `result.value` directly** - it's not type-safe and can cause runtime errors if `result` is an `Err`.

✅ **Always use one of the safe unwrapping methods** (`unwrap()`, `unwrapOr()`, `unwrapOrElse()`, `match()`, or type guards like `isOk()`).

