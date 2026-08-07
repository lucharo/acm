import CommentComposer from "./CommentComposer";
import type { CommentComposerProps } from "./CommentComposer";

export default function MobileCommentComposer(props: CommentComposerProps) {
  return (
    <div className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-md">
      <CommentComposer {...props} mobile />
    </div>
  );
}
