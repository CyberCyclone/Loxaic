import { useRef } from 'react';
import { Plus } from 'lucide-react-native';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import type { AttachButtonProps } from './AttachButton';

/**
 * Web attach control: a real, persistent `<input type="file">` rather than
 * expo-image-picker's web shim, which creates a transient hidden input at
 * click time and clicks it programmatically — nothing stable for e2e to
 * select. Kept mounted for the composer's lifetime and reset after every
 * selection so the same file can be re-picked twice in a row.
 */
export function AttachButton({ onFilesSelected }: AttachButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <Pressable
        testID="composer.attach"
        onPress={() => { inputRef.current?.click(); }}
        className="shrink-0 rounded-md border border-border bg-muted p-1.5"
      >
        <Icon as={Plus} size="2xs" className="text-foreground" />
      </Pressable>
      <input
        ref={inputRef}
        type="file"
        accept="image/*,.pdf,.docx,.xlsx,.pptx,.odt,.rtf,.epub,.txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.html,.htm,.xml,.yaml,.yml,.ts,.tsx,.js,.jsx,.py,.rb,.go,.rs,.java,.c,.h,.cpp,.cs,.php,.swift,.kt,.sh,.bash,.zsh,.sql,.toml,.ini,.cfg,.conf,.env,.diff,.patch,.log,.gitignore,.gitattributes,.dockerignore,.editorconfig,.npmrc,.nvmrc,.bashrc,.zshrc,.profile"
        multiple
        data-testid="composer.attach.input"
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = e.target.files ? Array.from(e.target.files) : [];
          // Reset so selecting the same file again still fires onChange.
          e.target.value = '';
          if (files.length > 0) onFilesSelected(files);
        }}
      />
    </>
  );
}
