import { useEffect, useId, useState } from "react";
import { THREAD_GROUP_NAME_MAX_LENGTH } from "@t3tools/contracts";
import { normalizeThreadGroupName } from "@t3tools/client-runtime/state/thread-sort";
import { create } from "zustand";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

type Request = {
  readonly title: string;
  readonly initialValue: string;
  readonly resolve: (name: string | null) => void;
};
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

export function requestThreadGroupName(input: {
  readonly title: string;
  readonly initialValue?: string;
}): Promise<string | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) =>
    useRequest.setState({
      request: { title: input.title, initialValue: input.initialValue ?? "", resolve },
    }),
  );
}

function finish(name: string | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(name);
}

export function ThreadGroupNameDialogHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => () => finish(null), []);
  return request ? <ThreadGroupNameDialog request={request} /> : null;
}

function ThreadGroupNameDialog(props: { readonly request: Request }) {
  const id = useId();
  const [value, setValue] = useState(props.request.initialValue);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            const name = normalizeThreadGroupName(value);
            if (name === null) {
              setError(`Use a name up to ${THREAD_GROUP_NAME_MAX_LENGTH} characters.`);
              return;
            }
            finish(name);
          }}
        >
          <DialogHeader>
            <DialogTitle>{props.request.title}</DialogTitle>
            <DialogDescription>
              Threads in this group stay in the same project folder.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Label className="flex flex-col items-stretch gap-1.5" htmlFor={id}>
              Name
              <Input
                id={id}
                autoFocus
                value={value}
                maxLength={THREAD_GROUP_NAME_MAX_LENGTH}
                onChange={(event) => {
                  setValue(event.target.value);
                  setError(null);
                }}
              />
            </Label>
            {error ? (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button type="submit">Save</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
