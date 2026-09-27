'use client';
import { ActivityIndicator } from 'react-native';
import React from 'react';
import { tva } from '@gluestack-ui/utils/nativewind-utils';
import { withUniwind } from 'uniwind';


const StyledActivityIndicator = withUniwind(ActivityIndicator);
const spinnerStyle = tva({});

const Spinner = React.forwardRef<
  React.ComponentRef<typeof ActivityIndicator>,
  React.ComponentProps<typeof ActivityIndicator>
>(function Spinner(
  {
    className,
    color,
    focusable = false,
    'aria-label': ariaLabel = 'loading',
    ...props
  },
  ref
) {
  // `spinnerStyle` has no base classes, so with no className it returns
  // undefined — and withUniwind turns a className prop that is present but
  // undefined into `{ tailwind: undefined }`, which react-native-web's styleq
  // reports as an error on every bare <Spinner /> (the red "styleq: tailwind
  // typeof undefined" toast in a dev build). Leave the prop out instead.
  const styled = spinnerStyle({ class: className });
  return (
    <StyledActivityIndicator
      ref={ref}
      focusable={focusable}
      aria-label={ariaLabel}
      {...props}
      color={color}
      {...(styled ? { className: styled } : {})}
    />
  );
});

Spinner.displayName = 'Spinner';

export { Spinner };
