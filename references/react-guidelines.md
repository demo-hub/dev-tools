React / React Native Coding Guidelines
======================================

**React Native · Expo · Next.js**

* * *

## 1. TypeScript

### 1.1 Strict mode — no shortcuts

Never suppress the compiler with `any`, `// @ts-ignore`, or `// @ts-expect-error` without a justifying comment.

    // ✓ Good
    function getUser(id: string): User | undefined {
      return users.find(u => u.id === id);
    }
    

    // ✗ Avoid
    function getUser(id: any): any {
      return users.find((u: any) => u.id === id);
    }
    

* * *

### 1.2 Types vs interfaces

Use `type` for component props, function signatures, and unions. Use `interface` only when declaration merging is explicitly needed.

    // ✓ Good
    type LoginButtonProps = {
      label: string;
      onPress: () => void;
      disabled?: boolean;
    };
    

* * *

### 1.3 Annotate return types

Always annotate the return type of non-trivial functions and all React components.

    // ✓ Good
    function formatCurrency(amount: number, currency: string): string {
      return `${amount.toFixed(2)} ${currency}`;
    }
    
    const LoanCard = ({ amount }: LoanCardProps): React.JSX.Element => { ... };
    

* * *

### 1.4 Union types over enums

Prefer union types over `enum`. Enums produce runtime objects with unexpected behaviour; unions are erased at compile time.

    // ✓ Good
    type LoanStatus = 'pending' | 'approved' | 'rejected';
    
    // ✗ Avoid
    enum LoanStatus { Pending = 'pending', Approved = 'approved' }
    

* * *

## 2. Component Architecture — Atomic Design

We follow the [Atomic Design methodology](https://atomicdesign.bradfrost.com/chapter-2/). Every component belongs to exactly one level. When reviewing a PR, check that new components are placed at the right level and that complexity hasn't leaked downward.

### Levels

| Level | What it is | Examples |
| --- | --- | --- |
| **Atom** | Smallest functional UI unit. No business logic, no data fetching. Purely presentational, highly reusable. | `Button`, `Badge`, `Avatar`, `InputField`, `Spinner` |
| **Molecule** | A simple group of atoms working together as a unit. Still generic — not tied to a specific domain. | `SearchBar`, `FormField`, `NotificationItem`, `LoanStatusBadge` |
| **Organism** | A distinct, self-contained section of the UI. May contain molecules and atoms. Can own local state and call `useQuery` directly. | `LoanList`, `AccountHeader`, `TransactionTable`, `NavigationDrawer` |
| **Template** | Page layout. Defines structure and slots — no real data, no business logic. | `DashboardLayout`, `AuthLayout`, `ModalShell` |
| **Page / Screen** | Composes organisms into a full screen. Owns prefetching, mutations, and navigation logic. | `LoanDetailScreen`, `DashboardPage`, `LoginScreen` |

### Rules

*   Atoms and molecules must be **stateless and generic** — no domain-specific data fetching, no direct API calls.
*   Organisms may own local UI state (`useState`, `useReducer`) and **may call `useQuery` directly**. TanStack Query's cache deduplicates requests — there is no extra network cost if a screen and an organism share the same query key.
*   Screens are the natural place to **prefetch** data and coordinate mutations, not the exclusive place to read it.
*   Never skip levels — a screen should not import an atom directly when a molecule or organism already composes it.

* * *

## 3. Components

### 3.1 One component per file

Each file exports exactly one component. The filename matches the component name in PascalCase.

* * *

### 3.2 Props destructuring

Always destructure props in the function signature.

    // ✓ Good
    const NotificationBanner = ({ title, body, onDismiss }: NotificationBannerProps): React.JSX.Element => { ... };
    
    // ✗ Avoid
    const NotificationBanner = (props: NotificationBannerProps): React.JSX.Element => {
      console.log(props.title);
    };
    

* * *

### 3.3 No inline component definitions

Never define a component inside another component's render body. It re-creates the component on every render and breaks reconciliation.

    // ✓ Good — defined outside
    const EmptyState = (): React.JSX.Element => <Text>No results</Text>;
    
    const LoanList = (): React.JSX.Element => {
      return loans.length === 0 ? <EmptyState /> : <FlatList ... />;
    };
    
    // ✗ Avoid
    const LoanList = (): React.JSX.Element => {
      const EmptyState = () => <Text>No results</Text>; // recreated every render
      ...
    };
    

* * *

### 3.4 Memoization — only when justified

Do not wrap everything in `React.memo`, `useMemo`, or `useCallback` by default. Apply them only when a measurable performance problem exists and profiling confirms it.

    // ✓ Justified — passed to FlatList renderItem which re-renders frequently
    const renderItem = useCallback(({ item }: { item: Loan }) => (
      <LoanCard loan={item} />
    ), []);
    
    // ✗ Premature — no evidence this is a bottleneck
    const label = useMemo(() => `Hello, ${name}`, [name]);
    

* * *

## 4. Effects — You Might Not Need One

> Reference: [react.dev/learn/you-might-not-need-an-effect](https://react.dev/learn/you-might-not-need-an-effect)

`useEffect` is an escape hatch for synchronising with **external systems**. It is not a general-purpose reaction mechanism. Before writing an effect, ask: does this involve an external system (network, native API, third-party widget)? If not, you probably don't need one.

### 4.1 Derived state — compute during render, not in an effect

If a value can be calculated from existing props or state, calculate it inline. Do not store it in state and sync it with an effect.

    // ✓ Good — computed during render
    const fullName = `${firstName} ${lastName}`;
    
    // ✗ Avoid — redundant state + unnecessary effect
    const [fullName, setFullName] = useState('');
    useEffect(() => {
      setFullName(`${firstName} ${lastName}`);
    }, [firstName, lastName]);
    

* * *

### 4.2 User events belong in event handlers, not effects

If something happens because the user did something, handle it in the event handler — not in an effect that reacts to a state change caused by the event.

    // ✓ Good — side effect triggered directly in the handler
    const handlePurchase = async (): Promise<void> => {
      await api.buy(itemId);
      showNotification('Purchase confirmed');
    };
    
    // ✗ Avoid — effect watching state set by the handler
    useEffect(() => {
      if (purchased) {
        showNotification('Purchase confirmed');
      }
    }, [purchased]);
    

* * *

### 4.3 Expensive filtering/transformation — useMemo, not an effect

    // ✓ Good
    const visibleLoans = useMemo(
      () => loans.filter(l => l.status === activeFilter),
      [loans, activeFilter]
    );
    
    // ✗ Avoid
    const [visibleLoans, setVisibleLoans] = useState<Loan[]>([]);
    useEffect(() => {
      setVisibleLoans(loans.filter(l => l.status === activeFilter));
    }, [loans, activeFilter]);
    

* * *

### 4.4 Explicit dependency arrays — no suppression

Every `useEffect` must have an explicit dependency array. Do not suppress the `exhaustive-deps` ESLint rule. If compliance feels impossible, the logic likely belongs in an event handler or a custom hook.

* * *

### 4.5 Legitimate uses of useEffect

*   Subscribing to native device APIs (notifications, accelerometer, deep links)
*   Syncing with a third-party SDK or analytics library
*   Running an imperative animation on mount
*   Responding to Expo `AppState` or `BackHandler` events

* * *

## 5. Hooks

### 5.1 Rules of hooks

Only call hooks at the top level — never inside conditions, loops, or nested functions. Only call hooks from function components or custom hooks.

* * *

### 5.2 Custom hooks

Extract stateful or side-effectful logic into custom hooks prefixed with `use`. Any hook used in more than one component must be extracted.

    // ✓ Good
    function useAccountSummary(accountId: string) {
      return useQuery({
        queryKey: ['account', accountId],
        queryFn: () => fetchAccountSummary(accountId),
      });
    }
    

* * *

## 6. State Management

### 6.1 TanStack Query for server state — colocate queries with consumers

All remote data must go through TanStack Query. Do not manually fetch in `useEffect` and store results in `useState`.
Any component at organism level or above may call `useQuery` directly. The cache deduplicates requests — if an organism and its parent screen share the same query key, only one network request is made. This eliminates prop drilling, prevents waterfall fetches, and lets organisms be reused across screens without each screen needing to know what data they need.
Screens are responsible for **prefetching** (calling `queryClient.prefetchQuery` before the organism mounts) and for owning **mutations** (`useMutation`).

    // ✓ Good — organism fetches its own data
    const LoanList = ({ userId }: LoanListProps): React.JSX.Element => {
      const { data: loans, isLoading } = useQuery({
        queryKey: loanKeys.byUser(userId),
        queryFn: () => loanService.getLoans(userId),
      });
      ...
    };
    
    // ✓ Good — screen prefetches so LoanList renders with data immediately
    const DashboardScreen = (): React.JSX.Element => {
      const queryClient = useQueryClient();
    
      useEffect(() => {
        queryClient.prefetchQuery({
          queryKey: loanKeys.byUser(currentUser.id),
          queryFn: () => loanService.getLoans(currentUser.id),
        });
      }, [currentUser.id]);
    
      return <LoanList userId={currentUser.id} />;
    };
    
    // ✗ Avoid — screen fetches and drills data down as props
    const DashboardScreen = (): React.JSX.Element => {
      const { data: loans } = useQuery({ queryKey: loanKeys.byUser(userId), queryFn: ... });
      return <LoanList loans={loans} />; // LoanList now coupled to parent's fetch
    };
    

* * *

### 6.2 Query key factories

Query keys must be descriptive arrays, not plain strings. Co-locate query key factories with their query functions.

    // ✓ Good
    export const loanKeys = {
      all: ['loans'] as const,
      byUser: (userId: string) => ['loans', userId] as const,
      detail: (loanId: string) => ['loans', 'detail', loanId] as const,
    };
    

* * *

### 6.3 React Context — scope and purpose

Context is for cross-cutting app-level state: auth session, theme, locale, feature flags. Do not use Context as a substitute for TanStack Query or local component state.

    // ✓ Good use of Context
    const AuthContext = React.createContext<AuthContextValue | null>(null);
    
    // ✗ Avoid — server data in Context
    const LoansContext = React.createContext<Loan[]>([]); // use TanStack Query instead
    

* * *

### 6.4 Local state scope

Keep state as close to where it is used as possible. Lift state up only when two or more sibling components genuinely share it.

* * *

## 7. Styling (Gluestack + Custom Design System)

### 7.1 Design system tokens — no hardcoded values

All colours, spacing, typography, and radii must come from the design system. Never hardcode hex values, pixel sizes, or font names.

    // ✓ Good
    <Box bg="$primary500" p="$4" borderRadius="$md">
      <Text color="$textLight50" fontSize="$sm">Balance</Text>
    </Box>
    
    // ✗ Avoid
    <View style={{ backgroundColor: '#0066CC', padding: 16 }}>
      <Text style={{ color: '#FFFFFF', fontSize: 14 }}>Balance</Text>
    </View>
    

* * *

### 7.2 Gluestack components over raw primitives

Prefer Gluestack components (`Box`, `Text`, `Pressable`, `HStack`, `VStack`) over raw React Native primitives when an equivalent exists. Fall back to RN primitives only when Gluestack doesn't cover the use case.

* * *

### 7.3 No inline styles

Never use the `style` prop for anything covered by the design system tokens.

    // ✗ Avoid
    <Text style={{ fontWeight: 'bold', marginTop: 8 }}>Total</Text>
    
    // ✓ Good
    <Text fontWeight="$bold" mt="$2">Total</Text>
    

> **Exception** — dynamic values that cannot be expressed as tokens (e.g. a width derived from a runtime measurement) may use inline styles with a comment explaining why.

* * *

### 7.4 Responsive styles via Gluestack breakpoints

Use Gluestack's responsive prop syntax instead of `Platform.OS` checks or manual dimension logic for layout differences between RN and web (Next.js).

    // ✓ Good
    <Box w={{ base: '$full', md: '$1/2' }} />
    

* * *

## 8. Expo & Platform Considerations

*   Use Expo SDK APIs (`expo-notifications`, `expo-secure-store`, `expo-router`) over bare RN equivalents unless there is a specific reason not to.
*   Use `Platform.OS` checks sparingly and only when behaviour genuinely differs between iOS, Android, and web. Prefer Gluestack responsive props for layout differences.
*   For Next.js screens, respect SSR constraints — no access to `window`, `localStorage`, or native APIs at module level. Guard with `typeof window !== 'undefined'` or inside `useEffect` where necessary.

* * *

## 9. Navigation

*   Screen components must not contain business logic — delegate to hooks and services.
*   Type all navigation params using the root navigator's param list type.
*   Never navigate imperatively from inside a hook that is not explicitly a navigation hook.

    // ✓ Good — typed params
    type RootStackParamList = {
      LoanDetail: { loanId: string };
      Dashboard: undefined;
    };
    

* * *

10. Error handling
------------------

*   All async operations must handle errors explicitly — never swallow `catch` blocks silently.
*   Use TanStack Query's `error` state for query errors and `onError` for mutation failures.
*   Surface user-facing errors through the design system's error components, not raw `Alert.alert`.

    // ✓ Good
    const { error } = useQuery({ queryKey: loanKeys.byUser(userId), queryFn: ... });
    
    if (error) {
      return <ErrorState message={error.message} />;
    }
    

* * *

Appendix: Quick Reference
-------------------------

| Rule | Status |
| --- | --- |
| `strict: true` — no `any`, no `@ts-ignore` | Required |
| `type` for props and unions | Required |
| Annotate return types on components and non-trivial functions | Required |
| Union types over `enum` | Required |
| Follow Atomic Design levels (atom / molecule / organism / template / screen) | Required |
| Organisms may call `useQuery` — cache handles deduplication | Required |
| Screens own prefetching and mutations | Required |
| One component per file, PascalCase filename | Required |
| Destructure props in signature | Required |
| No inline component definitions | Required |
| `useMemo` / `useCallback` / `React.memo` only when profiled | Required |
| Derived state computed inline — not in `useEffect` | Required |
| User event side effects in event handlers — not in `useEffect` | Required |
| No `exhaustive-deps` suppression | Required |
| Custom hooks prefixed with `use` | Required |
| TanStack Query for all server state — no manual `useEffect` fetching | Required |
| Query key factories co-located with query functions | Recommended |
| Context for app-level cross-cutting state only | Required |
| Design system tokens — no hardcoded colours or sizes | Required |
| Gluestack components over raw RN primitives | Required |
| No inline `style` prop for token-covered values | Required |
| Expo SDK APIs preferred over bare RN equivalents | Required |
| SSR-safe code in shared Next.js/Expo layers | Required |
| Typed navigation params | Required |
| Explicit error handling — no silent `catch` | Required |

* * *

_Questions? Propose changes via a PR against this document in the team wiki._
