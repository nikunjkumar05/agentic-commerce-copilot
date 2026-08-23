import { motion } from 'framer-motion';
import { Brain } from 'lucide-react';

export default function AiThinking({ message = 'AI is generating your invoice...' }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-start gap-3 p-4"
    >
      <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
        <Brain className="w-5 h-5 text-primary" />
      </div>
      <div className="flex-1">
        <p className="text-xs font-semibold text-primary mb-2">AI Co-Pilot</p>
        <div className="bg-muted/50 rounded-2xl rounded-tl-sm px-4 py-3">
          <p className="text-sm text-muted-foreground">{message}</p>
          <div className="flex gap-1 mt-2">
            {[0, 1, 2].map(i => (
              <motion.div
                key={i}
                className="w-2 h-2 rounded-full bg-primary/40"
                animate={{ scale: [1, 1.4, 1], opacity: [0.4, 1, 0.4] }}
                transition={{ duration: 1, repeat: Infinity, delay: i * 0.2 }}
              />
            ))}
          </div>
        </div>
      </div>
    </motion.div>
  );
}