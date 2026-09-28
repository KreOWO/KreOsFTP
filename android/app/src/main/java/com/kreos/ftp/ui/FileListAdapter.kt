package com.kreos.ftp.ui

import android.content.Context
import android.graphics.Color
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.LinearLayout
import android.widget.TextView
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

data class PaneRow(
    val name: String,
    val directory: Boolean,
    val size: Long,
    val modifiedAt: Long?,
    val value: Any?
)

class FileListAdapter(private val context: Context) : BaseAdapter() {
    var rows: List<PaneRow> = emptyList()
        set(value) {
            field = value
            notifyDataSetChanged()
        }

    override fun getCount(): Int = rows.size
    override fun getItem(position: Int): PaneRow = rows[position]
    override fun getItemId(position: Int): Long = position.toLong()

    override fun getView(position: Int, recycled: View?, parent: ViewGroup?): View {
        val row = (recycled as? LinearLayout) ?: LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = dp(42)
            setPadding(dp(10), dp(3), dp(8), dp(3))
            addView(cell(1f, Gravity.START))
            addView(cell(0f, Gravity.END, 76))
            addView(cell(0f, Gravity.START, 112))
        }
        val item = getItem(position)
        (row.getChildAt(0) as TextView).apply {
            text = (if (item.directory && item.name != "..") "▸ " else "") + item.name
            setTextColor(if (item.directory) Color.rgb(110, 190, 255) else Color.rgb(215, 224, 234))
        }
        (row.getChildAt(1) as TextView).text = if (item.directory) "—" else formatSize(item.size)
        (row.getChildAt(2) as TextView).text = item.modifiedAt?.let(::formatDate) ?: "—"
        return row
    }

    private fun cell(weight: Float, gravity: Int, width: Int = 0): TextView = TextView(context).apply {
        textSize = 12f
        setTextColor(Color.rgb(140, 153, 171))
        maxLines = 1
        ellipsize = android.text.TextUtils.TruncateAt.END
        this.gravity = gravity or Gravity.CENTER_VERTICAL
        layoutParams = LinearLayout.LayoutParams(if (weight > 0) 0 else dp(width), -1, weight)
    }

    private fun formatSize(bytes: Long): String {
        if (bytes < 1024) return "$bytes B"
        val units = arrayOf("KB", "MB", "GB", "TB")
        var value = bytes.toDouble()
        var unit = -1
        do {
            value /= 1024
            unit++
        } while (value >= 1024 && unit < units.lastIndex)
        return if (value >= 10) "%.0f %s".format(Locale.US, value, units[unit])
        else "%.1f %s".format(Locale.US, value, units[unit])
    }

    private fun formatDate(value: Long): String =
        SimpleDateFormat("dd.MM yy HH:mm", Locale.getDefault()).format(Date(value))

    private fun dp(value: Int): Int = (value * context.resources.displayMetrics.density).toInt()
}
