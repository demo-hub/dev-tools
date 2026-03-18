C# Coding Guidelines
====================

**.NET 8 · C# 12**

* * *

## 1. Code Style

### 1.1 Using directives

System namespaces come first, then third-party, then internal. Remove unused usings.

    // ✓ Good
    using System;
    using System.Collections.Generic;
    
    using ThirdParty.Utilities;
    
    using MyNamespace;
    

    // ✗ Avoid
    using MyNamespace;
    using System;
    using ThirdParty.Utilities;
    using System.Collections.Generic;
    // also: unused usings left in
    

> **New in C# 10+** — Prefer global usings in a `GlobalUsings.cs` file for namespaces used across the project (e.g. MediatR, FluentValidation). This reduces noise in individual files.
> 
>     // GlobalUsings.cs
>     global using MediatR;
>     global using FluentValidation;
>     

* * *

### 1.2 Explicit types — no `var`

Always declare types explicitly. `var` obscures intent and makes diffs harder to review.

    // ✓ Good
    int count = 10;
    string name = "João";
    List<Customer> customers = new();
    

    // ✗ Avoid
    var count = 10;
    var name = "João";
    var customers = new List<Customer>();
    

> **Exception** — `var` is acceptable when the type is unambiguous on the right-hand side and the variable is scoped tightly (e.g. collection/object initializers). Use judgment — when in doubt, be explicit.

* * *

### 1.3 Predefined type aliases

Use C# aliases, not .NET type names.

    // ✓ Good
    int number = 10;
    string name = "John";
    bool isActive = true;
    

    // ✗ Avoid
    Int32 number = 10;
    String name = "John";
    Boolean isActive = true;
    

* * *

### 1.4 Braces & formatting

Always use Allman style (opening brace on its own line). Always use curly braces, even for single-line blocks.

    // ✓ Good
    void Method()
    {
        if (condition)
        {
            DoSomething();
        }
    }
    

    // ✗ Avoid
    void Method(){
        if (condition)
            DoSomething();
    }
    

* * *

### 1.5 File-scoped namespaces

Use file-scoped namespace declarations. Reduces unnecessary nesting.

    // ✓ Good
    namespace MyApp.Services;
    
    public class CustomerService
    {
    }
    

    // ✗ Avoid
    namespace MyApp.Services
    {
        public class CustomerService
        {
        }
    }
    

* * *

### 1.6 Namespace matches folder structure

The namespace must always reflect the folder path from the project root.

    // ✓ Good — File: src/Services/Loans/LoanService.cs
    namespace MyApp.Services.Loans;
    

    // ✗ Avoid — File: src/Services/Loans/LoanService.cs
    namespace MyApp.Core.Helpers;
    

* * *

## 2. Language Features


### 2.1 Null handling

Use null-coalescing (`??`) and null-propagation (`?.`) instead of explicit null checks.

    // ✓ Good
    string display = name ?? "Default";
    string? city = customer?.Address?.City;
    

    // ✗ Avoid
    string display = name != null ? name : "Default";
    
    string? city = null;
    if (customer != null)
    {
        city = customer.Address?.City;
    }
    

> **NRTs (.NET 8)** — With nullable reference types enabled by default, the compiler will warn on unguarded dereferences. Treat warnings as errors in CI — do not suppress without justification.

* * *

### 2.2 Simplified expressions

Prefer concise, idiomatic C# over verbose equivalents.
| ✓ Good | ✗ Avoid |
| --- | --- |
| `if (isActive) { ... }` | `if (isActive == true) { ... }` |
| `x += 5;` | `x = x + 5;` |
| `$"Hello, {name}"` | `string.Format("Hello, {0}", name)` |
| `list.Count > 0` | `list.Count() > 0` |

* * *

### 2.3 Collection and object initializers

Initialise collections and objects inline where possible.

    // ✓ Good
    List<Customer> list = new()
    {
        new Customer { Name = "Ana" },
        new Customer { Name = "Rui" }
    };
    

    // ✗ Avoid
    List<Customer> list = new List<Customer>();
    Customer c1 = new Customer();
    c1.Name = "Ana";
    list.Add(c1);
    

> **New in C# 12** — Use collection expressions `[]` for simpler cases.
> 
>     int[] nums = [1, 2, 3];
>     List<string> tags = ["a", "b"];
>     

* * *

### 2.4 Pattern matching

> **New guidance for .NET 8 / C# 8+**

Use pattern matching to express intent clearly. Avoid verbose type-checking chains.

    // ✓ Good
    if (shape is Circle { Radius: > 10 } c)
    {
        Console.WriteLine(c.Radius);
    }
    
    string label = status switch
    {
        Status.Active  => "Active",
        Status.Pending => "Pending",
        _              => "Unknown"
    };
    

    // ✗ Avoid
    if (shape is Circle)
    {
        Circle c = (Circle)shape;
        if (c.Radius > 10)
        {
            Console.WriteLine(c.Radius);
        }
    }
    

* * *

### 2.5 Records for DTOs and value objects

> **New guidance for .NET 8 / C# 9+**

Use `record` types for immutable data carriers. Prefer `record` over `class` for DTOs, API response models, and value objects.

    // ✓ Good
    public record LoanRequest(decimal Amount, int TermMonths);
    
    // With validation
    public record CreateUserRequest
    {
        public required string Name { get; init; }
        public required string Email { get; init; }
    }
    

    // ✗ Avoid
    public class LoanRequest
    {
        public decimal Amount { get; set; }
        public int TermMonths { get; set; }
    }
    

* * *

### 2.6 Primary constructors (C# 12)

> **New in C# 12**

Use primary constructors for service classes where constructor parameters are captured as-is.

    // ✓ Good
    public class LoanService(
        ILoanRepository repository,
        ILogger<LoanService> logger)
    {
        public async Task<Loan> GetAsync(int id, CancellationToken ct)
        {
            return await repository.GetByIdAsync(id, ct);
        }
    }
    

    // ✗ Avoid (verbose boilerplate)
    public class LoanService
    {
        private readonly ILoanRepository _repository;
        private readonly ILogger<LoanService> _logger;
    
        public LoanService(ILoanRepository repository, ILogger<LoanService> logger)
        {
            _repository = repository;
            _logger = logger;
        }
    }
    

* * *

### 2.7 `required` members

> **New in C# 11 / .NET 7+**

Use `required` on properties that must be set at construction time. Prefer this over constructor overloads for simple init-only models.

    public class NotificationConfig
    {
        public required string Title { get; init; }
        public required string Body { get; init; }
        public string? DeepLink { get; init; }
    }
    

* * *

## 3. Async & Concurrency

> **New section — not covered in previous guidelines.**

### 3.1 async / await

Always await async methods — never block with `.Result` or `.Wait()`. Pass `CancellationToken` through the entire call chain on all I/O methods.

    // ✓ Good
    public async Task<Loan> GetLoanAsync(int id, CancellationToken ct = default)
    {
        return await _repository.GetByIdAsync(id, ct);
    }
    

    // ✗ Avoid — blocks the thread
    public Loan GetLoan(int id)
    {
        return _repository.GetByIdAsync(id).Result;
    }
    

* * *

### 3.2 ConfigureAwait

Do **not** use `ConfigureAwait(false)` in application code (controllers, services, handlers). It is only appropriate in library code with no ambient context dependency.

    // ✓ Good — application code
    CustomerDto dto = await _service.GetAsync(id, ct);
    

    // ✗ Avoid — wrong in application/API code
    CustomerDto dto = await _service.GetAsync(id).ConfigureAwait(false);
    

* * *

### 3.3 Naming

Async methods must be suffixed with `Async`. Non-async methods must not use the `Async` suffix.
| ✓ Good | ✗ Avoid |
| --- | --- |
| `Task<Loan> GetLoanAsync(int id, CancellationToken ct)` | `Task<Loan> GetLoan(int id)` |
| `void ProcessSync()` | `void ProcessSyncAsync()` |

* * *

## 4. Nullable Reference Types

> **New section — NRTs are enabled by default in all new .NET 8 projects.**

Treat the compiler as the source of truth for nullability. Do not annotate with `!` (null-forgiving operator) to silence warnings without a justifying comment.

    // ✓ Good
    string? optionalName = GetName();
    string requiredName = GetRequiredName();
    
    if (optionalName is not null)
    {
        Use(optionalName);
    }
    

    // ✗ Avoid
    string name = GetName()!;   // silencing the compiler without reason
    
    #nullable disable           // disabling NRTs — fix the issue instead
    

**Rules:**
*   Always annotate return types and parameters correctly with `?` for nullable references.
*   Avoid `#nullable disable` — fix the underlying issue instead.
*   Prefer `is not null` or `??` over `!= null` for null checks.

* * *

## 5. Performance

### 5.1 Collection size checks

Use `.Count` or `.Length` over LINQ `.Count()`. The property is O(1); the method enumerates.

    // ✓ Good
    if (list.Count > 0) { ... }
    if (array.Length == 0) { ... }
    

    // ✗ Avoid
    if (list.Count() > 0) { ... }
    if (array.Count() == 0) { ... }
    

* * *

### 5.2 AsSpan / AsMemory

Use `AsSpan()` or `AsMemory()` instead of range-based indexers **only in known hot paths** (tight loops, serialisation, high-throughput processing). Do not apply universally — it adds cognitive overhead for no benefit in typical service code.

    // ✓ Appropriate — hot path
    ReadOnlySpan<byte> slice = buffer.AsSpan(offset, length);
    

    // ✗ Unnecessary — ordinary service code
    ReadOnlySpan<char> sub = name.AsSpan(1, 3);
    // just use: string sub = name.Substring(1, 3);
    

* * *

## 6. Testing

Every PR that changes logic must include or update tests. See the **Testing & TDD Guidelines** for the full spec. Key principles:
*   Write the failing test first (red), then implement (green), then refactor.
*   Test names must describe behaviour, not implementation: `Approve_WhenAmountExceedsLimit_ThrowsDomainException`, not `TestApprove`.
*   Tests must fail without the change under test.
*   Avoid unnecessary mocks — use real domain objects where possible.
*   One assertion concept per test.

    // ✓ Good
    [Fact]
    public void Approve_WhenAmountExceedsLimit_ThrowsDomainException()
    {
        LoanApplication app = new(Amount: 200_000);
    
        Action act = () => app.Approve(limit: 100_000);
    
        act.Should().Throw<DomainException>()
            .WithMessage("*exceeds*");
    }
    

    // ✗ Avoid
    [Fact]
    public void TestApprove()
    {
        Mock<ILoanRepo> mock = new();
        LoanService svc = new(mock.Object);
        svc.Approve(new LoanApplication()); // no assertion on real behaviour
    }
    

* * *

## 7. API & Contract Safety

*   API and contract changes must be backward compatible — never remove or rename fields in a live contract without a deprecation lifecycle.
*   DB and config changes must be safe for rolling deployment (additive migrations, no destructive column drops in the same PR).
*   Risky features must be gated behind feature toggles.

* * *

Appendix: Quick Reference
-------------------------

| Rule | C# Version | Status |
| --- | --- | --- |
| System usings first, then third-party, then internal | All | Required |
| Global usings in `GlobalUsings.cs` | C# 10+ | Recommended |
| Explicit types — no `var` (with noted exception) | All | Required |
| Predefined aliases (`int`, `string`, `bool`) | All | Required |
| Allman braces, always | All | Required |
| File-scoped namespaces | C# 10+ | Required |
| Namespace matches folder | All | Required |
| Remove unused usings | All | Required |
| Null coalescing `??` | All | Required |
| Null propagation `?.` | All | Required |
| No `== true` / `== false` | All | Required |
| Collection initializers | All | Required |
| Collection expressions `[]` | C# 12 | Recommended |
| Compound assignments (`+=`, `-=`) | All | Required |
| String interpolation `$""` | All | Required |
| `.Count` / `.Length` over `.Count()` | All | Required |
| Pattern matching | C# 8+ | Recommended |
| Records for DTOs / value objects | C# 9+ | Recommended |
| `required` members | C# 11+ | Recommended |
| Primary constructors | C# 12 | Recommended |
| `Async` suffix on async methods | All | Required |
| `CancellationToken` on I/O methods | All | Required |
| No `ConfigureAwait(false)` in app code | All | Required |
| NRT annotations — no `!` suppression | .NET 8 | Required |
| `AsSpan` / `AsMemory` — hot paths only | All | Contextual |

* * *

_Questions? Propose changes via a PR against this document in the team wiki._
