Server utility components:

```tsx
<Suspense fallback={<LoadingComponent />}>
  <RealComponent />
</Suspense>
```

Not sure how this should handle user errors, we don't usually get some obscure AND recoverable errors. -->

```tsx
<ErrorBoundary fallback={"Oh noo"}>
  <RealComponent />
</ErrorBoundary>
```

Uses Activity for it's children?

```tsx
<IntersectionObserver>
  <PartialComponent />
</IntersectionObserver>
```

Not sure what to do? How is this different than Suspense?

```tsx
<Optimistic preview={<OptimisticComponent />}>
  <RealComponent />
</Optimistic>
```

Client utility components, maybe this now replaced by Activity.

```tsx
<MediaQuery></MediaQuery>
<LazyHydrate></LazyHydrate>
<ViewTransition><Partial/></ViewTransition>?
```

GraphQL @defer support in combination with Suspense.
GraphQL response cache and query caching. Add a product to the cart and dont need to refetch the cart because the same normalized cache is shared between the two requests, creating a faster roundtrip.
